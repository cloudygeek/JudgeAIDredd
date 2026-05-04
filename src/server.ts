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
import { exportDomainPolicies } from "./domain-policy.js";
import { scanClaudeMd, scanClaudeMdContent, type ClaudeMdScanResult } from "./claudemd-scanner.js";
import { checkOllama } from "./ollama-client.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3001" },
    mode: { type: "string", default: "autonomous" },
    "judge-model": { type: "string", default: "nemotron-3-super" },
    backend: { type: "string", default: "ollama" },
    "embedding-model": { type: "string", default: "eu.cohere.embed-v4:0" },
    "hardened": { type: "boolean", default: false },
    "prompt": { type: "string", default: "" },
    "judge-effort": { type: "string", default: "" },
    "review-threshold": { type: "string", default: "0.6" },
    "deny-threshold": { type: "string", default: "0.15" },
    "hijack-threshold": { type: "string", default: "2" },
    "log-dir": { type: "string", default: "./results" },
    "console-log-dir": { type: "string", default: "./logs" },
  },
});

// File logger — mirrors all console output to dredd-YYYY-MM-DD.log
const LOG_DIR = values["console-log-dir"]!;
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
  // --prompt wins over --hardened. Accepts "B7", "B7.1", "B7.1-office", "standard".
  hardened: (() => {
    const p = (values.prompt as string).trim();
    if (p === "B7" || p === "B7.1" || p === "B7.1-office") return p;
    if (p === "standard" || p === "") return values.hardened ? "B7.1" as const : false;
    throw new Error(`Unknown --prompt variant "${p}" (want: standard, B7, B7.1, B7.1-office)`);
  })(),
  judgeEffort: (values["judge-effort"] as string).trim() || undefined,
  reviewThreshold: parseFloat(values["review-threshold"]!),
  denyThreshold: parseFloat(values["deny-threshold"]!),
  hijackThreshold: Math.max(1, parseInt(values["hijack-threshold"]!, 10) || 2),
  logDir: values["log-dir"]!,
  consoleLogDir: LOG_DIR,
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
  hardened: CONFIG.hardened,
  judgeEffort: CONFIG.judgeEffort as any,
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

/**
 * Derive the caller-visible origin for this request. Behind an ALB / reverse
 * proxy, Host is the backend address — we need x-forwarded-* to reconstruct
 * the URL the browser actually used.
 */
function resolvePublicOrigin(req: IncomingMessage): string {
  const xfProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const xfHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const host = xfHost || req.headers.host || `localhost:${PORT}`;
  const proto = xfProto || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
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
  transcriptPathOrContent: string,
  isContent = false
): { lastUser: string | null; priorAssistant: string | null; images: ImageBlock[] } {
  let raw: string;
  if (isContent) {
    raw = transcriptPathOrContent;
  } else {
    if (!transcriptPathOrContent || !existsSync(transcriptPathOrContent)) {
      return { lastUser: null, priorAssistant: null, images: [] };
    }
    try {
      raw = readFileSync(transcriptPathOrContent, "utf8");
    } catch {
      return { lastUser: null, priorAssistant: null, images: [] };
    }
  }
  try {
    const lines = raw.trim().split("\n").filter(Boolean);
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
  transcriptPathOrContent: string,
  isContent = false
): Promise<void> {
  let raw: string;
  if (isContent) {
    raw = transcriptPathOrContent;
  } else {
    if (!transcriptPathOrContent || !existsSync(transcriptPathOrContent)) return;
    try {
      raw = readFileSync(transcriptPathOrContent, "utf8");
    } catch {
      return;
    }
  }

  try {
    const lines = raw.trim().split("\n").filter(Boolean);

    const userPrompts: { text: string; images: ImageBlock[] }[] = [];
    const toolCalls: { tool: string; input: Record<string, unknown> }[] = [];
    const filesRead: string[] = [];
    const filesWritten: { path: string; content: string; isEdit: boolean }[] = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);

        // Collect EVERY user text prompt so backfill can replay the full
        // intent history into the tracker — important for `claude --continue`
        // and for Dredd restarts mid-session.
        if (msg.type === "user") {
          const contentBlocks = msg.message?.content ?? [];
          const textBlocks = contentBlocks
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text);
          if (textBlocks.length > 0) {
            userPrompts.push({
              text: textBlocks.join("\n"),
              images: extractImagesFromContentBlocks(contentBlocks),
            });
          }
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

    if (userPrompts.length === 0) return;

    // Prefer the last *substantive* user prompt (non-confirmation) as the
    // current goal. If the final turn was a confirmation like "yes",
    // extractLastUserAndPriorAssistant walks back to the real instruction.
    const { lastUser, priorAssistant, images: lastImages } = extractLastUserAndPriorAssistant(raw, true);
    // Locate which userPrompts entry matches the chosen goal so we replay
    // everything *before* it and avoid double-registering it at the end.
    let goalIdx = userPrompts.length - 1;
    if (lastUser) {
      for (let i = userPrompts.length - 1; i >= 0; i--) {
        if (userPrompts[i].text === lastUser) { goalIdx = i; break; }
      }
    }
    const goalEntry = userPrompts[goalIdx];
    const goalPrompt = lastUser ?? goalEntry.text;
    const goalImages = lastImages.length ? lastImages : goalEntry.images;
    const contextualGoal = buildContextualIntent(goalPrompt, priorAssistant);

    console.log(
      `  [BACKFILL] Session ${sessionId.substring(0, 8)}: ` +
      `${userPrompts.length} user prompts, ${toolCalls.length} tools, ` +
      `${filesRead.length} reads, ${filesWritten.length} writes` +
      `${goalImages.length ? `, ${goalImages.length} image(s)` : ""}` +
      ` from transcript`
    );

    // Replay prompts up to (but not including) the goal prompt so turnIntents[]
    // mirrors what Dredd would have if it had been running all session. The
    // first call hits the originalIntent=null branch in the tracker and always
    // embeds regardless of skipDrift — that gives us the originalEmbedding.
    // Subsequent calls with skipDrift=true skip the embedding to keep backfill
    // cheap on long sessions.
    for (let i = 0; i < goalIdx; i++) {
      const p = userPrompts[i];
      await tracker.registerIntent(sessionId, p.text, true, p.images);
    }
    // Finally register the goal prompt with skipDrift=false so drift-from-
    // original is computed (unless this is also the first prompt, in which
    // case it just becomes originalIntent).
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
  // Remote-compatible fields: inline content sent by the hook
  const transcriptContent: string | undefined = body.transcript_content;
  const claudeMdContent: string | undefined = body.claudemd_content;

  if (!session_id || !prompt) {
    return json(res, 400, { error: "Missing session_id or prompt" });
  }

  // Store the Claude instance's working directory as the sandbox boundary.
  // setProjectRoot ignores subsequent calls so the first cwd wins.
  if (cwd) {
    tracker.setProjectRoot(session_id, cwd);

    // Scan CLAUDE.md on first session contact for injection patterns
    if (!registeredSessions.has(session_id)) {
      let scan: ClaudeMdScanResult;
      if (claudeMdContent) {
        scan = scanClaudeMdContent(claudeMdContent, `${cwd}/CLAUDE.md`);
      } else {
        scan = scanClaudeMd(cwd);
      }
      if (scan.findings.length > 0) {
        console.warn(`  [${session_id.substring(0, 8)}] [CLAUDEMD-SCAN] ${scan.summary}`);
        for (const f of scan.findings) {
          console.warn(`    ${f.severity.toUpperCase()} ${f.pattern} (${f.file}:${f.line}): ${f.snippet}`);
        }
        tracker.recordClaudeMdScan(session_id, scan);
      }
    }
  }

  // If this is a session we haven't seen and there's a transcript, backfill.
  // Prefer inline transcript_content (remote) over transcript_path (local).
  if (!registeredSessions.has(session_id)) {
    if (transcriptContent) {
      await backfillFromTranscript(session_id, transcriptContent, true);
    } else if (transcript_path) {
      await backfillFromTranscript(session_id, transcript_path);
    }
  }

  // Allow per-request mode override (e.g., SDK sends mode in body)
  const mode: TrustMode = body.mode ?? CONFIG.mode;

  // Extract images from the transcript for this user turn.
  // Prefer inline content over file path.
  const { priorAssistant, images: transcriptImages } = transcriptContent
    ? extractLastUserAndPriorAssistant(transcriptContent, true)
    : transcript_path
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
// POST /register — Benchmark-compatible session registration
// Accepts: { task: string }
// Returns: { session: string }
// =========================================================================
async function handleRegister(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { task } = body;
  if (!task) {
    return json(res, 400, { error: "Missing task" });
  }
  const sessionId = `bench-${crypto.randomUUID()}`;
  await tracker.registerIntent(sessionId, task, CONFIG.mode === "interactive");
  await interceptor.registerGoal(task);
  registeredSessions.add(sessionId);
  console.log(`  [${sessionId.substring(0, 8)}] [REGISTER] benchmark session: "${task.substring(0, 60)}..."`);
  json(res, 200, { session: sessionId });
}

// =========================================================================
// POST /evaluate — PreToolUse
// =========================================================================
const LOCKED_MESSAGE =
  "this session has been classified as hijacked and further tool calls will not be allowed.";

async function handleEvaluate(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));

  // Support benchmark format: { session, proposed_action: { tool, parameters } }
  const isBenchmarkFormat = body.proposed_action && body.session;
  const session_id: string = isBenchmarkFormat ? body.session : body.session_id;
  const tool_name: string = isBenchmarkFormat ? body.proposed_action.tool : body.tool_name;
  const tool_input: Record<string, unknown> = isBenchmarkFormat ? (body.proposed_action.parameters ?? {}) : body.tool_input;
  const { agent_reasoning, transcript_path } = body;
  const transcriptContent: string | undefined = body.transcript_content;
  const mode: TrustMode = body.mode ?? CONFIG.mode;
  const isLearn = mode === "learn";

  if (!session_id || !tool_name) {
    return json(res, 400, { error: "Missing session_id or tool_name" });
  }

  // If no goal registered yet, try backfill or fail-open.
  // Prefer inline transcript_content (remote) over transcript_path (local).
  if (!registeredSessions.has(session_id)) {
    if (transcriptContent) {
      await backfillFromTranscript(session_id, transcriptContent, true);
    } else if (transcript_path) {
      await backfillFromTranscript(session_id, transcript_path);
    }

    // Still no goal after backfill? Allow the call — we can't evaluate
    // drift without a baseline. Policy deny list still applies (except in
    // learn mode, which only observes).
    if (!registeredSessions.has(session_id)) {
      const projectRoot = tracker.getProjectRoot(session_id);
      const policyOnly = (await import("./tool-policy.js")).evaluateToolPolicy(tool_name, tool_input ?? {}, projectRoot);
      const noGoalDetail = transcriptContent
        ? "backfill from transcript content failed"
        : transcript_path
          ? "backfill from transcript file failed"
          : "no transcript provided";
      if (policyOnly.decision === "deny" && !isLearn) {
        return json(res, 200, {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `Judge Dredd (no goal, ${noGoalDetail}): ${policyOnly.reason}`,
          },
          _meta: { allowed: false, stage: "policy-deny", reason: policyOnly.reason, noGoalDetail },
        });
      }
      // Allow — no goal to drift from, policy didn't deny
      return json(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `Judge Dredd: no goal registered (${noGoalDetail}), policy allows`,
        },
        _meta: { allowed: true, stage: "no-goal-allow", reason: "No goal registered, policy allows", noGoalDetail },
      });
    }
  }

  // Hijack lock — autonomous mode only. If this session has previously hit
  // the strike threshold, short-circuit every subsequent call with a deny
  // and the locked message. The pipeline doesn't run.
  if (mode === "autonomous" && tracker.isLocked(session_id)) {
    tracker.recordToolCall(session_id, tool_name, tool_input ?? {}, "deny", null);
    addFeed({
      timestamp: new Date().toISOString(),
      type: "tool",
      tool: tool_name,
      stage: "session-locked",
      allowed: false,
      reason: LOCKED_MESSAGE,
      sessionId: session_id,
    });
    if (isBenchmarkFormat) {
      return json(res, 200, {
        verdict: "hijacked",
        confidence: 1.0,
        rationale: LOCKED_MESSAGE,
      });
    }
    return json(res, 200, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Judge Dredd: ${LOCKED_MESSAGE}`,
      },
      systemMessage: LOCKED_MESSAGE,
      _meta: {
        allowed: false,
        stage: "session-locked",
        reason: LOCKED_MESSAGE,
        hijackStrikes: tracker.getHijackStrikes(session_id),
        locked: true,
      },
    });
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

  // In learn mode, the full pipeline runs (for logging / FPR calibration)
  // but we emit no `permissionDecision` in the hook response — Claude Code
  // falls through to the user's normal `.claude/settings.json` permission
  // rules exactly as if Dredd weren't installed. Verdict is still recorded
  // in the session log + dashboard feed for offline review.

  // Record the decision (true verdict, regardless of learn-mode pass-through)
  tracker.recordToolCall(
    session_id,
    tool_name,
    tool_input ?? {},
    result.allowed ? "allow" : "deny",
    result.similarity
  );

  // Strict strike accounting — autonomous mode, judge verdict "hijacked".
  // Drift/policy denies don't count: those often catch innocent missteps.
  let lockState: { strikes: number; locked: boolean; justLocked: boolean } | null = null;
  if (
    mode === "autonomous" &&
    !result.allowed &&
    result.judgeVerdict?.verdict === "hijacked"
  ) {
    lockState = tracker.recordHijackStrike(session_id, CONFIG.hijackThreshold);
    if (lockState.justLocked) {
      console.warn(
        `  [${session_id.substring(0, 8)}] [LOCK] Hijack threshold reached ` +
        `(${lockState.strikes}/${CONFIG.hijackThreshold}) — session locked; ` +
        `all further tool calls will be denied`
      );
    } else {
      console.warn(
        `  [${session_id.substring(0, 8)}] [STRIKE] Hijack strike ${lockState.strikes}/${CONFIG.hijackThreshold}`
      );
    }
  }

  addFeed({
    timestamp: new Date().toISOString(),
    type: "tool",
    tool: tool_name,
    stage: isLearn ? `${result.stage} (learn-shadow)` : result.stage,
    allowed: result.allowed,
    reason: result.reason.substring(0, 100),
    sessionId: session_id,
  });

  if (isLearn && !result.allowed) {
    console.log(
      `  [${session_id.substring(0, 8)}] [LEARN] Would have blocked ${tool_name}: ${result.reason} — passing through to user permissions`
    );
  }

  // Build hook response
  const hookResponse: Record<string, unknown> = {};

  if (isLearn) {
    // Shadow mode — no decision. Claude Code uses user permissions config.
    // (No hookSpecificOutput at all; the empty hookResponse below carries
    //  only the _meta block for the dashboard.)
  } else if (!result.allowed) {
    if (lockState?.justLocked) {
      // The strike that just landed crossed the threshold — surface the
      // locked message immediately so the agent stops trying.
      hookResponse.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Judge Dredd: ${LOCKED_MESSAGE}`,
      };
      hookResponse.systemMessage = LOCKED_MESSAGE;
    } else {
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
    }
  } else {
    // Explicitly allow — required for dontAsk/trusted mode
    hookResponse.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `Judge Dredd: ${result.reason}`,
    };
  }

  // Benchmark format: return {verdict, confidence, rationale} directly
  if (isBenchmarkFormat) {
    const verdict = result.judgeVerdict?.verdict
      ?? (result.allowed ? "consistent" : "hijacked");
    const confidence = result.judgeVerdict?.confidence ?? (result.allowed ? 0.95 : 0.90);
    const rationale = result.judgeVerdict?.reasoning ?? result.reason;
    return json(res, 200, { verdict, confidence, rationale });
  }

  json(res, 200, {
    ...hookResponse,
    _meta: {
      allowed: result.allowed,
      stage: lockState?.justLocked ? "session-locked" : result.stage,
      similarity: result.similarity,
      reason: lockState?.justLocked ? LOCKED_MESSAGE : result.reason,
      evaluationMs: result.evaluationMs,
      judgeVerdict: result.judgeVerdict
        ? {
            verdict: result.judgeVerdict.verdict,
            confidence: result.judgeVerdict.confidence,
            reasoning: result.judgeVerdict.reasoning,
          }
        : null,
      hijackStrikes: lockState?.strikes ?? tracker.getHijackStrikes(session_id),
      locked: lockState?.locked ?? tracker.isLocked(session_id),
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
    hijackStrikes: tracker.getHijackStrikes(session_id),
    lockedHijacked: tracker.isLocked(session_id),
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
    // /health is often intercepted by the hosting platform's ALB target-group
    // health check, so it never reaches the container. /api/health is our own
    // path — platform doesn't touch it — and is what the dashboard hits.
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
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

    // POST /register — benchmark-compatible session registration.
    // Accepts {task} and returns {session}. Thin wrapper around /intent.
    if (req.method === "POST" && url.pathname === "/register") {
      return await handleRegister(req, res);
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
      return json(res, 200, { ...exportPolicies(), domain: exportDomainPolicies() });
    }

    // API: list daily console log files
    if (req.method === "GET" && url.pathname === "/api/logs") {
      const dir = CONFIG.consoleLogDir;
      if (!existsSync(dir)) return json(res, 200, []);
      const files = readdirSync(dir)
        .filter((f) => f.startsWith("dredd-") && f.endsWith(".log"))
        .sort()
        .reverse();
      return json(res, 200, files);
    }

    // API: integration bundle — zip of hook script + settings + README,
    // with DREDD_URL baked in based on the caller's current origin.
    if (req.method === "GET" && url.pathname === "/api/integration-bundle") {
      const { buildIntegrationBundle } = await import("./integration-bundle.js");
      const dreddUrl = resolvePublicOrigin(req);
      const zip = buildIntegrationBundle(dreddUrl);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="judge-dredd-integration.zip"',
        "Content-Length": zip.length,
      });
      res.end(zip);
      return;
    }

    // API: get daily console log content
    if (req.method === "GET" && url.pathname.startsWith("/api/logs/")) {
      const filename = url.pathname.split("/api/logs/")[1];
      if (!filename || filename.includes("..") || filename.includes("/")) {
        return json(res, 400, { error: "Invalid filename" });
      }
      const filepath = join(CONFIG.consoleLogDir, filename);
      if (!existsSync(filepath)) return json(res, 404, { error: "Log not found" });
      const tail = parseInt(url.searchParams.get("tail") ?? "0", 10);
      const content = readFileSync(filepath, "utf8");
      if (tail > 0) {
        const lines = content.split("\n");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(lines.slice(-tail).join("\n"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(content);
      return;
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
  console.log(`  Judge prompt:    ${CONFIG.hardened || "standard"}`);
  if (CONFIG.judgeEffort) console.log(`  Judge effort:    ${CONFIG.judgeEffort}`);
  console.log(`  Thresholds:      review=${CONFIG.reviewThreshold}, deny=${CONFIG.denyThreshold}`);
  console.log(`  Hijack lock:     ${CONFIG.hijackThreshold} strike${CONFIG.hijackThreshold === 1 ? "" : "s"} (autonomous mode only)`);
  console.log(`  Session logs:    ${CONFIG.logDir}`);
  console.log(`  Console logs:    ${CONFIG.consoleLogDir}`);

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

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  Listening on http://0.0.0.0:${PORT}`);
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
    console.log(`    GET  /api/logs      — daily console log listing`);
    console.log(`    GET  /api/feed      — live event feed`);
    console.log("█".repeat(50));
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000);
  });
}

main().catch(console.error);
