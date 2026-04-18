/**
 * Judge Dredd HTTP Server
 *
 * Exposes the intent tracking and tool evaluation pipeline as HTTP
 * endpoints. Drop a one-liner hook into any Claude Code CLI or SDK
 * app and all evaluation logic stays here.
 *
 * Endpoints:
 *   POST /intent    — UserPromptSubmit: register intent, track drift
 *   POST /evaluate  — PreToolUse: three-stage tool evaluation
 *   POST /track     — PostToolUse: record file/env state
 *   POST /end       — Stop: write session log, cleanup
 *   GET  /health    — health check
 *   GET  /session/:id — get session state (debug)
 *
 * Usage:
 *   npx tsx src/server.ts
 *   npx tsx src/server.ts --port 3001
 *   npx tsx src/server.ts --judge-model nemotron-3-super --backend ollama
 *   npx tsx src/server.ts --backend bedrock
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { SessionTracker, type ImageBlock } from "./session-tracker.js";
import { PreToolInterceptor } from "./pretool-interceptor.js";
import { exportPolicies } from "./tool-policy.js";
import { scanClaudeMd, type ClaudeMdScanResult } from "./claudemd-scanner.js";
import { checkOllama } from "./ollama-client.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3001" },
    mode: { type: "string", default: "autonomous" },
    "judge-model": { type: "string", default: "nemotron-3-super" },
    backend: { type: "string", default: "ollama" },
    "embedding-model": { type: "string", default: "eu.cohere.embed-v4:0" },
    "review-threshold": { type: "string", default: "0.6" },
    "deny-threshold": { type: "string", default: "0.15" },
    "log-dir": { type: "string", default: "./results" },
  },
});

// File logger — mirrors all console output to logs/dredd-YYYY-MM-DD.log
const LOG_DIR = "./logs";
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `dredd-${date}.log`);
}

function appendToLogFile(line: string): void {
  try {
    appendFileSync(getLogFilePath(), line + "\n");
  } catch {}
}

// Prepend ISO timestamp to every console line so server logs are grep/sortable,
// and also write to the daily log file.
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const timestamp = `[${new Date().toISOString()}]`;
    original(timestamp, ...args);
    const parts = args.map(a => typeof a === "string" ? a : inspect(a, { depth: 4, breakLength: Infinity }));
    appendToLogFile(`${timestamp} ${parts.join(" ")}`);
  };
}

const PORT = parseInt(values.port!, 10);
type TrustMode = "interactive" | "autonomous" | "learn";

const CONFIG = {
  /** interactive = vibe coding (trust user prompts, update intent)
   *  autonomous  = SDK/pipeline (validate all prompts against original intent) */
  mode: (values.mode as TrustMode) ?? "autonomous",
  judgeModel: values["judge-model"]!,
  judgeBackend: (values.backend as "ollama" | "bedrock")!,
  embeddingModel: values["embedding-model"]!,
  reviewThreshold: parseFloat(values["review-threshold"]!),
  denyThreshold: parseFloat(values["deny-threshold"]!),
  logDir: values["log-dir"]!,
};

// Shared state
const feed: { timestamp: string; type: string; tool?: string; stage?: string; allowed?: boolean; reason?: string; prompt?: string; sessionId?: string }[] = [];
const MAX_FEED = 200;

function addFeed(entry: typeof feed[0]) {
  feed.push({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() });
  if (feed.length > MAX_FEED) feed.splice(0, feed.length - MAX_FEED);
}

const tracker = new SessionTracker(CONFIG.embeddingModel);
const interceptor = new PreToolInterceptor({
  judgeModel: CONFIG.judgeModel,
  judgeBackend: CONFIG.judgeBackend,
  embeddingModel: CONFIG.embeddingModel,
  reviewThreshold: CONFIG.reviewThreshold,
  denyThreshold: CONFIG.denyThreshold,
});

// Track which sessions have had their goal registered with the interceptor
const registeredSessions = new Set<string>();

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// =========================================================================
// Transcript Backfill
// =========================================================================

/**
 * When Dredd starts mid-session (or restarts), reconstruct state from
 * the Claude transcript file. Extracts the original task, tool history,
 * and file operations so the session tracker has full context.
 */
/**
 * Walk a Claude JSONL transcript and pull out the most recent user prompt
 * together with the assistant text that immediately preceded it. Used to
 * build the "intent" handed to the judge in interactive mode — a short user
 * reply only makes sense in the context of what the agent just said.
 */
/**
 * Short user replies like "yes", "ok", "do it", "option B" are confirmations
 * of the previous assistant turn — they are not standalone goals. Backfill
 * must walk past them to find the last substantive user prompt, otherwise
 * the judge ends up evaluating tool calls against "yes, option B".
 */
function isConfirmationPrompt(text: string): boolean {
  return (
    /^\s*(yes|yeah|yep|ok|okay|sure|do it|go ahead|go|proceed|continue|y|k|confirm|approved?|lgtm|ship it|sounds good|that's right|correct|exactly|please|thanks|thank you|option\s+\w+|👍)\b/i.test(text)
    && text.trim().length < 80
  );
}

function extractImagesFromContentBlocks(blocks: any[]): ImageBlock[] {
  const images: ImageBlock[] = [];
  for (const b of blocks) {
    if (b.type === "image" && b.source?.type === "base64" && b.source?.data) {
      images.push({
        data: b.source.data,
        mediaType: b.source.media_type ?? "image/png",
      });
    }
  }
  return images;
}

function extractLastUserAndPriorAssistant(
  transcriptPath: string
): { lastUser: string | null; priorAssistant: string | null; images: ImageBlock[] } {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { lastUser: null, priorAssistant: null, images: [] };
  }
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n").filter(Boolean);
    // Collect all user prompts with the assistant turn that immediately
    // preceded each one, then pick the last *substantive* (non-confirmation)
    // entry. Falls back to the very last user prompt if everything is a
    // confirmation.
    const userTurns: { user: string; prior: string | null; images: ImageBlock[] }[] = [];
    let pendingAssistant: string | null = null;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant") {
          const text = (msg.message?.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n")
            .trim();
          if (text) pendingAssistant = text;
        } else if (msg.type === "user") {
          const contentBlocks = msg.message?.content ?? [];
          const text = contentBlocks
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n")
            .trim();
          const imgs = extractImagesFromContentBlocks(contentBlocks);
          if (text || imgs.length) {
            userTurns.push({ user: text, prior: pendingAssistant, images: imgs });
          }
        }
      } catch {}
    }

    if (userTurns.length === 0) return { lastUser: null, priorAssistant: null, images: [] };

    // Walk backwards for the last substantive prompt.
    for (let i = userTurns.length - 1; i >= 0; i--) {
      if (!isConfirmationPrompt(userTurns[i].user)) {
        return { lastUser: userTurns[i].user, priorAssistant: userTurns[i].prior, images: userTurns[i].images };
      }
    }
    // All confirmations — fall back to the most recent.
    const last = userTurns[userTurns.length - 1];
    return { lastUser: last.user, priorAssistant: last.prior, images: last.images };
  } catch {
    return { lastUser: null, priorAssistant: null, images: [] };
  }
}

/**
 * Combine a user prompt with the previous assistant response into a single
 * "intent" string. Short user replies ("yes", "do that one", "the second
 * option") are meaningless without the agent's preceding turn.
 */
function buildContextualIntent(
  userPrompt: string,
  priorAssistant: string | null
): string {
  if (!priorAssistant) return userPrompt;
  // Cap the assistant context so the embedding/judge prompt stays bounded.
  const trimmed = priorAssistant.length > 2000
    ? priorAssistant.substring(priorAssistant.length - 2000)
    : priorAssistant;
  return `PREVIOUS ASSISTANT RESPONSE:\n${trimmed}\n\nUSER PROMPT:\n${userPrompt}`;
}

async function backfillFromTranscript(
  sessionId: string,
  transcriptPath: string
): Promise<void> {
  if (!transcriptPath || !existsSync(transcriptPath)) return;

  try {
    const content = readFileSync(transcriptPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);

    let firstUserPrompt: string | null = null;
    let firstUserImages: ImageBlock[] = [];
    let turnCount = 0;
    const toolCalls: { tool: string; input: Record<string, unknown> }[] = [];
    const filesRead: string[] = [];
    const filesWritten: { path: string; content: string; isEdit: boolean }[] = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);

        // Extract first user message as original intent
        if (msg.type === "user" && !firstUserPrompt) {
          const contentBlocks = msg.message?.content ?? [];
          const textBlocks = contentBlocks
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text);
          if (textBlocks.length > 0) {
            firstUserPrompt = textBlocks.join("\n");
            firstUserImages = extractImagesFromContentBlocks(contentBlocks);
          }
        }

        // Count user messages as turns
        if (msg.type === "user" && msg.message?.content?.some((b: any) => b.type === "text")) {
          turnCount++;
        }

        // Extract tool calls from assistant messages
        if (msg.type === "assistant") {
          const blocks = msg.message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "tool_use") {
              const tool = block.name;
              const input = block.input ?? {};
              toolCalls.push({ tool, input });

              // Track file operations
              if (tool === "Read") {
                filesRead.push(String(input.file_path ?? ""));
              }
              if (tool === "Write") {
                filesWritten.push({
                  path: String(input.file_path ?? ""),
                  content: String(input.content ?? ""),
                  isEdit: false,
                });
              }
              if (tool === "Edit") {
                filesWritten.push({
                  path: String(input.file_path ?? ""),
                  content: String(input.new_string ?? ""),
                  isEdit: true,
                });
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Prefer the *last* user prompt (combined with the prior assistant turn)
    // as the goal — backfill is only used when Dredd starts mid-session, and
    // the most recent exchange is what the agent is currently acting on.
    const { lastUser, priorAssistant, images: lastImages } = extractLastUserAndPriorAssistant(transcriptPath);
    const goalPrompt = lastUser ?? firstUserPrompt;
    if (!goalPrompt) return;
    const goalImages = lastImages.length ? lastImages : firstUserImages;
    const contextualGoal = buildContextualIntent(goalPrompt, priorAssistant);

    console.log(
      `  [BACKFILL] Session ${sessionId.substring(0, 8)}: ` +
      `${turnCount} turns, ${toolCalls.length} tools, ` +
      `${filesRead.length} reads, ${filesWritten.length} writes` +
      `${goalImages.length ? `, ${goalImages.length} image(s)` : ""}` +
      ` from transcript`
    );

    // Register the most-recent intent (with prior assistant context)
    await tracker.registerIntent(sessionId, goalPrompt, false, goalImages);
    await interceptor.registerGoal(contextualGoal, goalImages);
    registeredSessions.add(sessionId);

    // Replay file operations into the tracker
    for (const path of filesRead) {
      tracker.recordFileRead(sessionId, path, "(backfilled)");
    }
    for (const file of filesWritten) {
      tracker.recordFileWrite(sessionId, file.path, file.content, file.isEdit);
    }

    // Record tool calls
    for (const tc of toolCalls) {
      tracker.recordToolCall(sessionId, tc.tool, tc.input, "allow", null);
    }

    console.log(
      `  [BACKFILL] Latest intent: "${goalPrompt.substring(0, 60)}..." ` +
      `(prior assistant context: ${priorAssistant ? "yes" : "no"})`
    );
  } catch (err) {
    console.error(
      `  [BACKFILL] Failed for session ${sessionId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// =========================================================================
// POST /intent — UserPromptSubmit
// =========================================================================
async function handleIntent(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { session_id, prompt, transcript_path, cwd } = body;

  if (!session_id || !prompt) {
    return json(res, 400, { error: "Missing session_id or prompt" });
  }

  // Store the Claude instance's working directory as the sandbox boundary.
  // setProjectRoot ignores subsequent calls so the first cwd wins.
  if (cwd) {
    tracker.setProjectRoot(session_id, cwd);

    // Scan CLAUDE.md on first session contact for injection patterns
    if (!registeredSessions.has(session_id)) {
      const scan = scanClaudeMd(cwd);
      if (scan.findings.length > 0) {
        console.warn(`  [${session_id.substring(0, 8)}] [CLAUDEMD-SCAN] ${scan.summary}`);
        for (const f of scan.findings) {
          console.warn(`    ${f.severity.toUpperCase()} ${f.pattern} (${f.file}:${f.line}): ${f.snippet}`);
        }
        tracker.recordClaudeMdScan(session_id, scan);
      }
    }
  }

  // If this is a session we haven't seen and there's a transcript, backfill
  if (!registeredSessions.has(session_id) && transcript_path) {
    await backfillFromTranscript(session_id, transcript_path);
  }

  // Allow per-request mode override (e.g., SDK sends mode in body)
  const mode: TrustMode = body.mode ?? CONFIG.mode;

  // Extract images from the transcript for this user turn
  const { priorAssistant, images: transcriptImages } = transcript_path
    ? extractLastUserAndPriorAssistant(transcript_path)
    : { priorAssistant: null, images: [] as ImageBlock[] };

  const result = await tracker.registerIntent(session_id, prompt, mode === "interactive", transcriptImages);

  // Build a contextual goal: the user prompt combined with the assistant
  // response that immediately preceded it, so short replies retain meaning.
  const contextualGoal = buildContextualIntent(prompt, priorAssistant);

  if (transcriptImages.length) {
    console.log(
      `  [${session_id.substring(0, 8)}] [INTENT] ${transcriptImages.length} image(s) attached to intent`
    );
  }

  // Register goal with interceptor on first call per session
  if (result.isOriginal && !registeredSessions.has(session_id)) {
    await interceptor.registerGoal(contextualGoal, transcriptImages);
    registeredSessions.add(session_id);
  }

  if ((mode === "interactive" || mode === "learn") && !result.isOriginal) {
    // INTERACTIVE / LEARN MODE:
    // Every user prompt is trusted — they're steering.
    // But short confirmations ("yes", "ok", "do it", "go ahead") are
    // confirming the PREVIOUS intent, not setting a new one.
    // Only update the goal for substantive prompts.
    // Learn mode also updates intent so pipeline verdicts are evaluated
    // against the actual current goal, not a stale first prompt.
    const isConfirmation =
      /^\s*(yes|yeah|yep|ok|okay|sure|do it|go ahead|go|proceed|continue|y|k|confirm|approved?|lgtm|ship it|sounds good|that's right|correct|exactly|please|thanks|thank you|👍)\b/i.test(prompt)
      && prompt.trim().length < 80;

    if (isConfirmation) {
      console.log(
        `  [${session_id.substring(0, 8)}] [INTENT] ${mode} mode: "${prompt.trim()}" is a confirmation — keeping previous goal`
      );
    } else {
      await interceptor.registerGoal(contextualGoal, transcriptImages);
      console.log(
        `  [${session_id.substring(0, 8)}] [INTENT] ${mode} mode: updated goal to "${prompt.substring(0, 60)}..." ` +
        `(prior assistant context: ${priorAssistant ? "yes" : "no"}, ` +
        `drift from original: ${result.driftFromOriginal?.toFixed(3) ?? "n/a"})`
      );
    }
  }

  // Get appropriate reminder (only in autonomous mode)
  const classification = tracker.classifyDrift(result.driftFromOriginal);
  const reminder = mode === "autonomous"
    ? tracker.getGoalReminder(session_id, result.driftFromOriginal)
    : null;

  // Build hook response
  const hookResponse: Record<string, unknown> = {};

  if (reminder) {
    hookResponse.systemMessage = reminder;
  }

  addFeed({
    timestamp: new Date().toISOString(),
    type: "intent",
    prompt: prompt.substring(0, 100),
    sessionId: session_id,
    reason: `Turn ${result.turnNumber}: ${classification}${result.driftFromOriginal !== null ? ` (drift: ${result.driftFromOriginal.toFixed(3)})` : ""}`,
  });

  json(res, 200, {
    ...hookResponse,
    _meta: {
      isOriginal: result.isOriginal,
      turnNumber: result.turnNumber,
      driftFromOriginal: result.driftFromOriginal,
      driftFromPrevious: result.driftFromPrevious,
      classification,
    },
  });
}

// =========================================================================
// POST /evaluate — PreToolUse
// =========================================================================
async function handleEvaluate(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { session_id, tool_name, tool_input, agent_reasoning, transcript_path } = body;
  const mode: TrustMode = body.mode ?? CONFIG.mode;
  const isLearn = mode === "learn";

  if (!session_id || !tool_name) {
    return json(res, 400, { error: "Missing session_id or tool_name" });
  }

  // If no goal registered yet, try backfill or fail-open
  if (!registeredSessions.has(session_id)) {
    if (transcript_path) {
      await backfillFromTranscript(session_id, transcript_path);
    }

    // Still no goal after backfill? Allow the call — we can't evaluate
    // drift without a baseline. Policy deny list still applies (except in
    // learn mode, which only observes).
    if (!registeredSessions.has(session_id)) {
      const projectRoot = tracker.getProjectRoot(session_id);
      const policyOnly = (await import("./tool-policy.js")).evaluateToolPolicy(tool_name, tool_input ?? {}, projectRoot);
      if (policyOnly.decision === "deny" && !isLearn) {
        return json(res, 200, {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `Judge Dredd (no goal): ${policyOnly.reason}`,
          },
          _meta: { allowed: false, stage: "policy-deny", reason: policyOnly.reason },
        });
      }
      // Allow — no goal to drift from, policy didn't deny
      return json(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Judge Dredd: no goal registered yet, policy allows",
        },
        _meta: { allowed: true, stage: "no-goal-allow", reason: "No goal registered, policy allows" },
      });
    }
  }

  // Build file context for Bash/git commands
  let fileContext: string | undefined;
  if (tool_name === "Bash") {
    const command = String(tool_input?.command ?? "");
    const writtenFiles = tracker.getWrittenFiles(session_id);

    const referencesWritten = writtenFiles.some((f) =>
      command.includes(f.path) || command.includes(f.path.split("/").pop()!)
    );

    if (referencesWritten || /git\s+(add|commit|push)/.test(command)) {
      fileContext = tracker.getFileContextForJudge(session_id);
    }
  }

  // Combine file context and agent reasoning for the judge
  let fullContext = fileContext ?? "";
  if (agent_reasoning) {
    fullContext = (fullContext ? fullContext + "\n\n" : "") +
      `AGENT REASONING (why it wants to use this tool):\n${agent_reasoning}`;
  }

  const result = await interceptor.evaluate(
    tool_name,
    tool_input ?? {},
    fullContext || undefined,
    session_id,
    tracker.getProjectRoot(session_id)
  );

  // In learn mode, the pipeline still runs (for logging/observation) but
  // we never block — the would-be verdict is recorded as-is.
  const effectiveAllowed = isLearn ? true : result.allowed;

  // Record the decision (true verdict, not the learn-mode override)
  tracker.recordToolCall(
    session_id,
    tool_name,
    tool_input ?? {},
    result.allowed ? "allow" : "deny",
    result.similarity
  );

  addFeed({
    timestamp: new Date().toISOString(),
    type: "tool",
    tool: tool_name,
    stage: isLearn && !result.allowed ? `${result.stage} (learn-allow)` : result.stage,
    allowed: effectiveAllowed,
    reason: result.reason.substring(0, 100),
    sessionId: session_id,
  });

  if (isLearn && !result.allowed) {
    console.log(
      `  [${session_id.substring(0, 8)}] [LEARN] Would have blocked ${tool_name}: ${result.reason} — allowing anyway`
    );
  }

  // Build hook response
  const hookResponse: Record<string, unknown> = {};

  if (!effectiveAllowed) {
    // Use the interceptor's *current* working goal (which interactive mode
    // updates each turn) rather than the session's stale very-first prompt.
    const currentGoal = interceptor.getCurrentGoal()
      || tracker.getSessionContext(session_id).originalTask
      || "unknown";
    // Strip the contextual "PREVIOUS ASSISTANT RESPONSE: ..." prefix when
    // surfacing to the user — they only need to see the actual user prompt.
    const userVisibleGoal = currentGoal.includes("USER PROMPT:\n")
      ? currentGoal.split("USER PROMPT:\n").pop()!.trim()
      : currentGoal;
    hookResponse.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Judge Dredd: ${result.reason}`,
    };
    hookResponse.systemMessage =
      `[SECURITY] Tool call ${tool_name} was blocked. Reason: ${result.reason}. ` +
      `Stay focused on the current task: "${userVisibleGoal}".`;
  } else {
    // Explicitly allow — required for dontAsk/trusted mode
    hookResponse.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `Judge Dredd: ${result.reason}`,
    };
  }

  json(res, 200, {
    ...hookResponse,
    _meta: {
      allowed: result.allowed,
      stage: result.stage,
      similarity: result.similarity,
      reason: result.reason,
      evaluationMs: result.evaluationMs,
      judgeVerdict: result.judgeVerdict
        ? {
            verdict: result.judgeVerdict.verdict,
            confidence: result.judgeVerdict.confidence,
            reasoning: result.judgeVerdict.reasoning,
          }
        : null,
    },
  });
}

// =========================================================================
// POST /track — PostToolUse
// =========================================================================
async function handleTrack(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { session_id, tool_name, tool_input, tool_output } = body;

  if (!session_id || !tool_name) {
    return json(res, 400, { error: "Missing session_id or tool_name" });
  }

  // Track file reads
  if (tool_name === "Read") {
    tracker.recordFileRead(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_output ?? "")
    );
  }

  // Track file writes
  if (tool_name === "Write") {
    tracker.recordFileWrite(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_input?.content ?? ""),
      false
    );
  }

  // Track file edits
  if (tool_name === "Edit") {
    tracker.recordFileWrite(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_input?.new_string ?? ""),
      true
    );
  }

  // Track env vars in Bash
  if (tool_name === "Bash") {
    tracker.recordEnvVar(session_id, String(tool_input?.command ?? ""));
  }

  json(res, 200, {});
}

// =========================================================================
// POST /end — Stop
// =========================================================================
async function handleEnd(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (!session_id) {
    return json(res, 400, { error: "Missing session_id" });
  }

  const summary = tracker.getFullSessionSummary(session_id);
  const ctx = tracker.getSessionContext(session_id);
  const driftHistory = tracker.getDriftDetector(session_id).getHistory();

  // Write log
  const logDir = CONFIG.logDir;
  try { mkdirSync(logDir, { recursive: true }); } catch {}

  const logFile = join(
    logDir,
    `session-${session_id.substring(0, 12)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );

  const sessionLog = {
    sessionId: session_id,
    timestamp: new Date().toISOString(),
    originalTask: ctx.originalTask,
    summary,
    toolHistory: ctx.recentTools,
    filesWritten: tracker.getWrittenFiles(session_id).map((f) => ({
      path: f.path,
      writeCount: f.writeCount,
      containsCanary: f.containsCanary,
    })),
    envVars: tracker.getEnvVars(session_id),
    driftHistory,
    turnMetrics: summary.turnMetrics,
    interceptorLog: interceptor.getLog().map((r) => ({
      tool: r.tool,
      input: r.input,
      stage: r.stage,
      allowed: r.allowed,
      similarity: r.similarity,
      reason: r.reason,
      evaluationMs: r.evaluationMs,
    })),
  };

  writeFileSync(logFile, JSON.stringify(sessionLog, null, 2));

  console.log(
    `[END] Session ${session_id.substring(0, 8)}: ` +
    `${summary.turns} turns, ${summary.toolCalls} tools, ` +
    `${summary.denied} denied → ${logFile}`
  );

  // Cleanup
  registeredSessions.delete(session_id);
  tracker.endSession(session_id);

  json(res, 200, { logFile, summary });
}

// =========================================================================
// GET /session/:id — Debug
// =========================================================================
function handleSessionGet(res: ServerResponse, sessionId: string) {
  const ctx = tracker.getSessionContext(sessionId);
  const summary = tracker.getFullSessionSummary(sessionId);
  json(res, 200, { ...ctx, summary });
}

// =========================================================================
// POST /pivot — Explicit direction change (interactive mode)
// =========================================================================
async function handlePivot(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { session_id, reason } = body;

  if (!session_id) {
    return json(res, 400, { error: "Missing session_id" });
  }

  await tracker.pivotSession(session_id, reason ?? "User changed direction");

  // Reset the interceptor goal — next UserPromptSubmit will set the new one
  interceptor.reset();

  json(res, 200, { pivoted: true, reason: reason ?? "User changed direction" });
}

// =========================================================================
// POST /compact — Context compaction notification (PreCompact hook)
// =========================================================================
async function handleCompact(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (!session_id) {
    return json(res, 400, { error: "Missing session_id" });
  }

  // Context is being compacted — the model will lose older conversation.
  // We keep our full tracking state but note the boundary.
  console.log(
    `  [COMPACT] Session ${session_id.substring(0, 8)}: context compaction detected`
  );

  // Don't pivot — the intent hasn't changed, just the model's memory.
  // But record it in metrics so we know when it happened.
  const session = tracker.getSessionContext(session_id);
  tracker.recordTurnMetrics(
    session_id,
    null, // no drift measurement at compaction
    null,
    0,
    0,
    false,
    false
  );

  json(res, 200, { noted: true });
}

// =========================================================================
// Router
// =========================================================================
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const pkg = JSON.parse(
        (await import("node:fs")).readFileSync(
          new URL("../package.json", import.meta.url), "utf8"
        )
      );
      return json(res, 200, {
        status: "ok",
        version: pkg.version,
        config: CONFIG,
        activeSessions: registeredSessions.size,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/session/")) {
      const id = url.pathname.split("/session/")[1];
      return handleSessionGet(res, id);
    }

    if (req.method === "POST" && url.pathname === "/intent") {
      return await handleIntent(req, res);
    }

    if (req.method === "POST" && url.pathname === "/evaluate") {
      return await handleEvaluate(req, res);
    }

    if (req.method === "POST" && url.pathname === "/track") {
      return await handleTrack(req, res);
    }

    if (req.method === "POST" && url.pathname === "/end") {
      return await handleEnd(req, res);
    }

    if (req.method === "POST" && url.pathname === "/pivot") {
      return await handlePivot(req, res);
    }

    if (req.method === "POST" && url.pathname === "/compact") {
      return await handleCompact(req, res);
    }

    // ===== Dashboard & API =====

    // Serve dashboard
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      const html = readFileSync(
        new URL("./web/dashboard.html", import.meta.url), "utf8"
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    // Serve favicon
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      const ico = readFileSync(new URL("./web/favicon.ico", import.meta.url));
      res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" });
      res.end(ico);
      return;
    }

    // API: list session logs
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const logDir = CONFIG.logDir;
      if (!existsSync(logDir)) return json(res, 200, []);

      const files = readdirSync(logDir)
        .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
        .sort()
        .reverse()
        .slice(0, 50);

      const sessions = files.map((f) => {
        try {
          return JSON.parse(readFileSync(join(logDir, f), "utf8"));
        } catch {
          return null;
        }
      }).filter(Boolean);

      return json(res, 200, sessions);
    }

    // API: get session log by ID
    if (req.method === "GET" && url.pathname.startsWith("/api/session-log/")) {
      const id = url.pathname.split("/api/session-log/")[1];
      const logDir = CONFIG.logDir;
      if (!existsSync(logDir)) return json(res, 404, { error: "No logs" });

      const file = readdirSync(logDir)
        .filter((f) => f.includes(id.substring(0, 12)))
        .sort()
        .reverse()[0];

      if (!file) return json(res, 404, { error: "Session not found" });

      const data = JSON.parse(readFileSync(join(logDir, file), "utf8"));
      return json(res, 200, data);
    }

    // API: live feed
    if (req.method === "GET" && url.pathname === "/api/feed") {
      return json(res, 200, feed);
    }

    if (req.method === "GET" && url.pathname === "/api/policies") {
      return json(res, 200, exportPolicies());
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(`[ERROR] ${req.method} ${url.pathname}:`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// =========================================================================
// Startup
// =========================================================================
async function main() {
  const pkg = JSON.parse(
    (await import("node:fs")).readFileSync(
      new URL("../package.json", import.meta.url), "utf8"
    )
  );

  console.log("█".repeat(50));
  console.log(`  JUDGE AI DREDD — HTTP Server v${pkg.version}`);
  console.log("█".repeat(50));

  // Preflight
  await interceptor.preflight();
  console.log(`  Mode:            ${CONFIG.mode}`);
  console.log(`  Embedding model: ${CONFIG.embeddingModel}`);
  console.log(`  Judge backend:   ${CONFIG.judgeBackend}`);
  console.log(`  Judge model:     ${CONFIG.judgeModel}`);
  console.log(`  Thresholds:      review=${CONFIG.reviewThreshold}, deny=${CONFIG.denyThreshold}`);
  console.log(`  Log directory:   ${CONFIG.logDir}`);

  if (CONFIG.mode === "learn") {
    console.log(`\n  📖 Learn mode: pipeline runs but NOTHING is blocked`);
    console.log(`    Verdicts are logged for observation only. Use to gather data before enforcing.`);
  } else if (CONFIG.mode === "interactive") {
    console.log(`\n  ⚠ Interactive mode: user prompts are trusted, intent updates each turn`);
    console.log(`    Policy deny list still enforced. Drift logged but not blocked.`);
  } else {
    console.log(`\n  🔒 Autonomous mode: all prompts validated against original intent`);
    console.log(`    Scope creep at 0.2, drift warning at 0.3, block at 0.5.`);
  }

  server.listen(PORT, () => {
    console.log(`\n  Listening on http://localhost:${PORT}`);
    console.log(`\n  Dashboard:  http://localhost:${PORT}/`);
    console.log(`\n  Endpoints:`);
    console.log(`    POST /intent    — UserPromptSubmit (register intent)`);
    console.log(`    POST /evaluate  — PreToolUse (evaluate tool call)`);
    console.log(`    POST /track     — PostToolUse (record file/env state)`);
    console.log(`    POST /end       — Stop (write log, cleanup)`);
    console.log(`    POST /pivot     — explicit direction change`);
    console.log(`    POST /compact   — context compaction notification`);
    console.log(`    GET  /health    — health check + version`);
    console.log(`    GET  /api/sessions  — session log listing`);
    console.log(`    GET  /api/feed      — live event feed`);
    console.log("█".repeat(50));
  });
}

main().catch(console.error);
