/**
 * Hook-facing HTTP server.
 *
 * Hosts the hot path: POST /intent, /evaluate, /track, /end, /pivot,
 * /compact, /register. Plus status endpoints: /health, /api/health,
 * /api/data-status, /api/whoami. Plus the feed (cross-origin from the
 * dashboard) and the runtime mode toggle.
 *
 * What deliberately does NOT live here: dashboard HTML, session listings,
 * log file downloads, policies dump. Those live in `server-dashboard.ts`
 * and run in a separate container behind OIDC.
 *
 * CORS: /api/feed and /api/mode accept cross-origin requests from
 * DREDD_DASHBOARD_ORIGIN so the dashboard container's page can call them.
 * Every other endpoint is same-origin (the hook calls its own URL directly).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PORT,
  CONFIG,
  tracker,
  apiKeys,
  interceptor,
  registeredSessions,
  feed,
  addFeed,
  readBody,
  json,
  BODY_LIMIT_TRANSCRIPT,
  BodyTooLargeError,
  rejectInvalidSessionId,
  safeServerReadablePath,
  authenticateHookRequest,
  authStageForFeed,
  backfillFromTranscript,
  extractLastUserAndPriorAssistant,
  buildContextualIntent,
  buildSessionLogShape,
  flushLogs,
  type TrustMode,
} from "./server-core.js";
import type { ImageBlock } from "./session-store.js";
import { scanClaudeMd, scanClaudeMdContent, type ClaudeMdScanResult } from "./claudemd-scanner.js";

// CORS origin the dashboard container runs at. When unset, cross-origin
// requests are rejected — same-origin only, which is what the hook gets
// from Claude Code hooks.
const DASHBOARD_ORIGIN = process.env.DREDD_DASHBOARD_ORIGIN ?? "";

/**
 * Apply CORS headers for endpoints the dashboard container calls. Returns
 * true and ends the response for OPTIONS preflight so the caller can bail.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  if (!DASHBOARD_ORIGIN) return false;
  const origin = req.headers.origin;
  if (origin !== DASHBOARD_ORIGIN) return false;
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// =========================================================================
// POST /intent — UserPromptSubmit
// =========================================================================
async function handleIntent(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req, BODY_LIMIT_TRANSCRIPT));
  const { session_id, prompt, transcript_path, cwd } = body;
  const transcriptContent: string | undefined = body.transcript_content;
  const claudeMdContent: string | undefined = body.claudemd_content;

  if (rejectInvalidSessionId(res, session_id)) return;
  if (!prompt) {
    return json(res, 400, { error: "Missing prompt" });
  }

  // Stamp the session owner from the validated API key so the dashboard
  // can scope sessions to the signed-in Clerk user. First writer wins;
  // calling more than once with the same key is idempotent.
  if (identity.keyValid && identity.ownerSub) {
    await tracker.setSessionOwner(session_id, identity.ownerSub, identity.ownerEmail);
  }

  if (cwd) {
    await tracker.setProjectRoot(session_id, cwd);

    if (!registeredSessions.has(session_id)) {
      let scan: ClaudeMdScanResult | null = null;
      if (claudeMdContent) {
        scan = scanClaudeMdContent(claudeMdContent, `${cwd}/CLAUDE.md`);
      } else {
        const safeCwd = safeServerReadablePath(cwd);
        if (safeCwd) {
          scan = scanClaudeMd(safeCwd);
        }
      }
      if (scan && scan.findings.length > 0) {
        console.warn(`  [${session_id.substring(0, 8)}] [CLAUDEMD-SCAN] ${scan.summary}`);
        for (const f of scan.findings) {
          console.warn(`    ${f.severity.toUpperCase()} ${f.pattern} (${f.file}:${f.line}): ${f.snippet}`);
        }
        await tracker.recordClaudeMdScan(session_id, scan);
      }
    }
  }

  if (!registeredSessions.has(session_id)) {
    if (transcriptContent) {
      await backfillFromTranscript(session_id, transcriptContent, true);
    } else if (transcript_path) {
      await backfillFromTranscript(session_id, transcript_path);
    }
  }

  const mode: TrustMode = body.mode ?? CONFIG.mode;

  const { priorAssistant, images: transcriptImages } = transcriptContent
    ? extractLastUserAndPriorAssistant(transcriptContent, true)
    : transcript_path
      ? extractLastUserAndPriorAssistant(transcript_path)
      : { priorAssistant: null, images: [] as ImageBlock[] };

  const result = await tracker.registerIntent(session_id, prompt, mode === "interactive", transcriptImages);

  const contextualGoal = buildContextualIntent(prompt, priorAssistant);

  if (transcriptImages.length) {
    console.log(
      `  [${session_id.substring(0, 8)}] [INTENT] ${transcriptImages.length} image(s) attached to intent`
    );
  }

  if (result.isOriginal && !registeredSessions.has(session_id)) {
    await interceptor.registerGoal(session_id, contextualGoal, transcriptImages);
    registeredSessions.add(session_id);
  }

  if ((mode === "interactive" || mode === "learn") && !result.isOriginal) {
    // Treat short replies as confirmations of the previous turn rather than
    // standalone goals. Includes "option N" / "option foo" so users picking
    // from a clarifying question don't reset the goal to a meaningless
    // 2-word string. Stays in sync with isConfirmationPrompt() in
    // server-core.ts (used by transcript backfill) — divergence here was
    // the cause of "option 2" being treated as a new goal and tripping
    // drift-deny on the next tool call.
    const confirmationOnly =
      /^\s*(yes|yeah|yep|ok|okay|sure|do it|go ahead|go|proceed|continue|y|k|confirm|approved?|lgtm|ship it|sounds good|that's right|correct|exactly|please|thanks|thank you|option\s+\w+|👍)\s*[.!?👍]*\s*$/i;
    const isConfirmation = confirmationOnly.test(prompt) && prompt.trim().length < 80;

    if (isConfirmation) {
      console.log(
        `  [${session_id.substring(0, 8)}] [INTENT] ${mode} mode: "${prompt.trim()}" is a confirmation — keeping previous goal`
      );
    } else {
      await interceptor.registerGoal(session_id, contextualGoal, transcriptImages);
      console.log(
        `  [${session_id.substring(0, 8)}] [INTENT] ${mode} mode: updated goal to "${prompt.substring(0, 60)}..." ` +
        `(prior assistant context: ${priorAssistant ? "yes" : "no"}, ` +
        `drift from original: ${result.driftFromOriginal?.toFixed(3) ?? "n/a"})`
      );
    }
  }

  const classification = tracker.classifyDrift(result.driftFromOriginal);
  const reminder = mode === "autonomous"
    ? await tracker.getGoalReminder(session_id, result.driftFromOriginal)
    : null;

  const hookResponse: Record<string, unknown> = {};
  if (reminder) {
    hookResponse.systemMessage = reminder;
  }

  addFeed({
    timestamp: new Date().toISOString(),
    type: "intent",
    prompt: prompt.substring(0, 500),
    sessionId: session_id,
    reason: `Turn ${result.turnNumber}: ${classification}${result.driftFromOriginal !== null ? ` (drift: ${result.driftFromOriginal.toFixed(3)})` : ""}`,
    ownerSub: identity.ownerSub,
    authStage: authStageForFeed(identity),
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
// =========================================================================
async function handleRegister(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { task } = body;
  if (!task) {
    return json(res, 400, { error: "Missing task" });
  }
  const sessionId = `bench-${crypto.randomUUID()}`;
  await tracker.registerIntent(sessionId, task, CONFIG.mode === "interactive");
  await interceptor.registerGoal(sessionId, task);
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
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req, BODY_LIMIT_TRANSCRIPT));

  const isBenchmarkFormat = body.proposed_action && body.session;
  const session_id: string = isBenchmarkFormat ? body.session : body.session_id;
  const tool_name: string = isBenchmarkFormat ? body.proposed_action.tool : body.tool_name;
  const tool_input: Record<string, unknown> = isBenchmarkFormat ? (body.proposed_action.parameters ?? {}) : body.tool_input;
  const { agent_reasoning, transcript_path } = body;
  const transcriptContent: string | undefined = body.transcript_content;
  const mode: TrustMode = body.mode ?? CONFIG.mode;
  const isLearn = mode === "learn";

  if (rejectInvalidSessionId(res, session_id)) return;
  if (!tool_name) {
    return json(res, 400, { error: "Missing tool_name" });
  }

  if (!registeredSessions.has(session_id)) {
    if (transcriptContent) {
      await backfillFromTranscript(session_id, transcriptContent, true);
    } else if (transcript_path) {
      await backfillFromTranscript(session_id, transcript_path);
    }

    if (!registeredSessions.has(session_id)) {
      const projectRoot = await tracker.getProjectRoot(session_id);
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
            permissionDecisionReason: `Judge AI Dredd (no goal, ${noGoalDetail}): ${policyOnly.reason}`,
          },
          _meta: { allowed: false, stage: "policy-deny", reason: policyOnly.reason, noGoalDetail },
        });
      }
      return json(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `Judge AI Dredd: no goal registered (${noGoalDetail}), policy allows`,
        },
        _meta: { allowed: true, stage: "no-goal-allow", reason: "No goal registered, policy allows", noGoalDetail },
      });
    }
  }

  if (mode === "autonomous" && (await tracker.isLocked(session_id))) {
    await tracker.recordToolCall(session_id, tool_name, tool_input ?? {}, "deny", null);
    addFeed({
      timestamp: new Date().toISOString(),
      type: "tool",
      tool: tool_name,
      stage: "session-locked",
      allowed: false,
      reason: LOCKED_MESSAGE,
      sessionId: session_id,
      ownerSub: identity.ownerSub,
      authStage: authStageForFeed(identity),
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
        permissionDecisionReason: `Judge AI Dredd: ${LOCKED_MESSAGE}`,
      },
      systemMessage: LOCKED_MESSAGE,
      _meta: {
        allowed: false,
        stage: "session-locked",
        reason: LOCKED_MESSAGE,
        hijackStrikes: await tracker.getHijackStrikes(session_id),
        locked: true,
      },
    });
  }

  let fileContext: string | undefined;
  if (tool_name === "Bash") {
    const command = String(tool_input?.command ?? "");
    const writtenFiles = await tracker.getWrittenFiles(session_id);

    const referencesWritten = writtenFiles.some((f) =>
      command.includes(f.path) || command.includes(f.path.split("/").pop()!)
    );

    if (referencesWritten || /git\s+(add|commit|push)/.test(command)) {
      fileContext = await tracker.getFileContextForJudge(session_id);
    }
  }

  let fullContext = fileContext ?? "";
  if (agent_reasoning) {
    fullContext = (fullContext ? fullContext + "\n\n" : "") +
      `AGENT REASONING (why it wants to use this tool):\n${agent_reasoning}`;
  }

  const result = await interceptor.evaluate(
    session_id,
    tool_name,
    tool_input ?? {},
    fullContext || undefined,
    await tracker.getProjectRoot(session_id),
    mode
  );

  await tracker.recordToolCall(
    session_id,
    tool_name,
    tool_input ?? {},
    result.allowed ? "allow" : "deny",
    result.similarity
  );

  let lockState: { strikes: number; locked: boolean; justLocked: boolean } | null = null;
  if (
    mode === "autonomous" &&
    !result.allowed &&
    result.judgeVerdict?.verdict === "hijacked"
  ) {
    lockState = await tracker.recordHijackStrike(session_id, CONFIG.hijackThreshold);
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
    reason: result.reason.substring(0, 500),
    sessionId: session_id,
    ownerSub: identity.ownerSub,
    authStage: authStageForFeed(identity),
  });

  if (isLearn && !result.allowed) {
    console.log(
      `  [${session_id.substring(0, 8)}] [LEARN] Would have blocked ${tool_name}: ${result.reason} — passing through to user permissions`
    );
  }

  const hookResponse: Record<string, unknown> = {};

  if (isLearn) {
    // Shadow mode — no decision. Claude Code uses user permissions config.
  } else if (!result.allowed) {
    if (lockState?.justLocked) {
      hookResponse.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Judge AI Dredd: ${LOCKED_MESSAGE}`,
      };
      hookResponse.systemMessage = LOCKED_MESSAGE;
    } else {
      const currentGoal = interceptor.getCurrentGoal(session_id)
        || (await tracker.getSessionContext(session_id)).originalTask
        || "unknown";
      const userVisibleGoal = currentGoal.includes("USER PROMPT:\n")
        ? currentGoal.split("USER PROMPT:\n").pop()!.trim()
        : currentGoal;
      hookResponse.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Judge AI Dredd: ${result.reason}`,
      };
      hookResponse.systemMessage =
        `[SECURITY] Tool call ${tool_name} was blocked. Reason: ${result.reason}. ` +
        `Stay focused on the current task: "${userVisibleGoal}".`;
    }
  } else {
    hookResponse.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `Judge AI Dredd: ${result.reason}`,
    };
  }

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
      hijackStrikes: lockState?.strikes ?? (await tracker.getHijackStrikes(session_id)),
      locked: lockState?.locked ?? (await tracker.isLocked(session_id)),
    },
  });
}

// =========================================================================
// POST /track — PostToolUse
// =========================================================================
async function handleTrack(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id, tool_name, tool_input, tool_output } = body;

  if (rejectInvalidSessionId(res, session_id)) return;
  if (!tool_name) {
    return json(res, 400, { error: "Missing tool_name" });
  }

  if (tool_name === "Read") {
    await tracker.recordFileRead(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_output ?? "")
    );
  }

  if (tool_name === "Write") {
    await tracker.recordFileWrite(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_input?.content ?? ""),
      false
    );
  }

  if (tool_name === "Edit") {
    await tracker.recordFileWrite(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_input?.new_string ?? ""),
      true
    );
  }

  if (tool_name === "Bash") {
    await tracker.recordEnvVar(session_id, String(tool_input?.command ?? ""));
  }

  json(res, 200, {});
}

// =========================================================================
// POST /end — Stop
// =========================================================================
async function handleEnd(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  const sessionLog = await buildSessionLogShape(session_id);
  const summary = (sessionLog?.summary as any) ?? { turns: 0, toolCalls: 0, denied: 0 };

  console.log(
    `[END] Session ${session_id.substring(0, 8)}: ` +
    `${summary.turns} turns, ${summary.toolCalls} tools, ` +
    `${summary.denied} denied`
  );

  registeredSessions.delete(session_id);
  await tracker.endSession(session_id);
  interceptor.reset(session_id);

  json(res, 200, { summary });
}

// =========================================================================
// GET /session/:id — Debug
// =========================================================================
async function handleSessionGet(res: ServerResponse, sessionId: string) {
  if (rejectInvalidSessionId(res, sessionId)) return;
  const ctx = await tracker.getSessionContext(sessionId);
  const summary = await tracker.getFullSessionSummary(sessionId);
  json(res, 200, { ...ctx, summary });
}

// =========================================================================
// POST /pivot / /compact
// =========================================================================
async function handlePivot(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id, reason } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  await tracker.pivotSession(session_id, reason ?? "User changed direction");

  interceptor.reset(session_id);
  registeredSessions.delete(session_id);

  json(res, 200, { pivoted: true, reason: reason ?? "User changed direction" });
}

async function handleCompact(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  console.log(
    `  [COMPACT] Session ${session_id.substring(0, 8)}: context compaction detected`
  );

  await tracker.recordTurnMetrics(
    session_id,
    null,
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
    // GET / — tiny status landing page. The hook container has no
    // dashboard UI (that lives on the dashboard container). This page
    // is for operators / users who hit the URL directly to confirm
    // which container is on the other end and link them onward.
    if (req.method === "GET" && url.pathname === "/") {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      const dashboardOrigin = process.env.DREDD_DASHBOARD_ORIGIN ?? "";
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Judge AI Dredd — Hook API</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 40px 24px; }
  .card { max-width: 720px; margin: 0 auto; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #f0f6fc; }
  h1 span { color: #58a6ff; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; font-size: 13px; margin: 20px 0; }
  .k { color: #8b949e; }
  .v { color: #c9d1d9; word-break: break-all; }
  .v.green { color: #3fb950; }
  .v.amber { color: #d29922; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb; }
  ul { list-style: none; padding: 0; margin: 16px 0; }
  li { padding: 4px 0; }
  li code { color: #d29922; }
  a { color: #58a6ff; }
  .muted { color: #8b949e; font-size: 12px; margin-top: 24px; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
  <h1>Judge AI <span>Dredd</span> — Hook API</h1>
  <div class="sub">PreToolUse defence service for Claude Code hooks. <span class="pill">role: hook</span></div>

  <div class="grid">
    <div class="k">Version</div><div class="v">${pkg.version}</div>
    <div class="k">Status</div><div class="v green">ok</div>
    <div class="k">Mode</div><div class="v">${CONFIG.mode}</div>
    <div class="k">Backend</div><div class="v">${CONFIG.judgeBackend}</div>
    <div class="k">Judge model</div><div class="v">${CONFIG.judgeModel}</div>
    <div class="k">Embedding</div><div class="v">${CONFIG.embeddingModel}</div>
    <div class="k">Prompt variant</div><div class="v">${CONFIG.hardened || "standard"}</div>
    <div class="k">Active sessions</div><div class="v">${registeredSessions.size}</div>
    <div class="k">Auth mode</div><div class="v ${process.env.DREDD_AUTH_MODE === "required" ? "green" : "amber"}">${process.env.DREDD_AUTH_MODE ?? "optional"}</div>
  </div>

  <div style="font-size: 12px; color: #8b949e; margin: 16px 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Hook endpoints</div>
  <ul>
    <li><code>POST /intent</code> — UserPromptSubmit</li>
    <li><code>POST /evaluate</code> — PreToolUse (judge pipeline)</li>
    <li><code>POST /track</code> — PostToolUse</li>
    <li><code>POST /end</code> · <code>/pivot</code> · <code>/compact</code></li>
    <li><code>GET /api/health</code> · <code>/api/whoami</code> · <code>/api/data-status</code></li>
    <li><code>GET /api/feed</code> · <code>POST /api/mode</code> <span style="color:#8b949e">(cross-origin from dashboard)</span></li>
  </ul>

  <div class="muted">
    The full operator dashboard lives on a separate container.
    ${dashboardOrigin ? `<br>Dashboard: <a href="${dashboardOrigin}">${dashboardOrigin}</a>` : `<br>Dashboard origin not configured (DREDD_DASHBOARD_ORIGIN unset).`}
    <br>To install the hook in your project, run <code>curl -O ${"https://" + (req.headers["x-forwarded-host"] || req.headers.host || "localhost")}/api/integration-bundle</code> from the dashboard.
  </div>
</div>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // /health (ALB target-group health check) — never CORSed, never auth'd.
    if (req.method === "GET" && url.pathname === "/health") {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      return json(res, 200, {
        status: "ok",
        version: pkg.version,
        role: "hook",
        config: CONFIG,
        activeSessions: registeredSessions.size,
      });
    }

    // /api/health — same payload, but the dashboard browser polls this
    // cross-origin to render the version + mode badge in its top bar.
    // Apply CORS (and respond to OPTIONS preflight) so it works.
    if (url.pathname === "/api/health") {
      if (applyCors(req, res)) return;
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      return json(res, 200, {
        status: "ok",
        version: pkg.version,
        role: "hook",
        config: CONFIG,
        activeSessions: registeredSessions.size,
      });
    }

    // /api/whoami — OIDC discovery. No auth; read-only.
    if (req.method === "GET" && url.pathname === "/api/whoami") {
      const oidcData = req.headers["x-amzn-oidc-data"] as string | undefined;
      const oidcIdentity = req.headers["x-amzn-oidc-identity"] as string | undefined;
      const hasAccessToken = !!req.headers["x-amzn-oidc-accesstoken"];

      let claims: Record<string, unknown> | null = null;
      let decodeError: string | null = null;
      if (oidcData) {
        try {
          const parts = oidcData.split(".");
          if (parts.length === 3) {
            const payload = Buffer.from(parts[1], "base64").toString("utf8");
            claims = JSON.parse(payload);
          } else {
            decodeError = `Expected 3 JWT segments, got ${parts.length}`;
          }
        } catch (err) {
          decodeError = err instanceof Error ? err.message : String(err);
        }
      }

      return json(res, 200, {
        role: "hook",
        authWired: !!oidcData,
        identity: oidcIdentity ?? null,
        hasAccessToken,
        claims,
        decodeError,
        seenHeaders: Object.keys(req.headers)
          .filter((h) => h.toLowerCase().startsWith("x-amzn-"))
          .sort(),
      });
    }

    // /api/data-status — EFS mount probe. Used by the dashboard container
    // to show operators whether /data survives restart. Read-only.
    if (req.method === "GET" && url.pathname === "/api/data-status") {
      const sessionDir = CONFIG.logDir;
      const consoleDir = CONFIG.consoleLogDir;
      const dataDir =
        sessionDir.endsWith("/sessions") ? sessionDir.slice(0, -"/sessions".length) : sessionDir;

      let mounts: Array<{ source: string; target: string; fstype: string; options: string }> = [];
      try {
        mounts = readFileSync("/proc/mounts", "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [source, target, fstype, options] = line.split(/\s+/);
            return { source, target, fstype, options };
          });
      } catch {
        // Not Linux.
      }

      const mountFor = (path: string) => {
        const match = mounts
          .filter((m) => path === m.target || path.startsWith(m.target + "/"))
          .sort((a, b) => b.target.length - a.target.length)[0];
        return match ?? null;
      };

      const describeDir = (dir: string) => {
        if (!existsSync(dir)) {
          return { path: dir, exists: false };
        }
        let files: string[] = [];
        try { files = readdirSync(dir); } catch { files = []; }
        let bytes = 0;
        let newest: { name: string; mtime: string; size: number } | null = null;
        for (const name of files) {
          try {
            const st = statSync(join(dir, name));
            if (!st.isFile()) continue;
            bytes += st.size;
            if (!newest || st.mtimeMs > Date.parse(newest.mtime)) {
              newest = { name, mtime: new Date(st.mtimeMs).toISOString(), size: st.size };
            }
          } catch {}
        }
        return { path: dir, exists: true, fileCount: files.length, totalBytes: bytes, newest };
      };

      const dataMount = mountFor(dataDir);
      return json(res, 200, {
        dataDir,
        sessionDir,
        consoleDir,
        mount: dataMount
          ? {
              source: dataMount.source,
              target: dataMount.target,
              fstype: dataMount.fstype,
              options: dataMount.options,
              persistent:
                dataMount.fstype === "nfs" ||
                dataMount.fstype === "nfs4" ||
                dataMount.fstype === "efs" ||
                !["overlay", "overlay2", "tmpfs", "aufs"].includes(dataMount.fstype),
            }
          : { persistent: false, note: "not a mount point — ephemeral container layer" },
        sessions: describeDir(sessionDir),
        logs: describeDir(consoleDir),
      });
    }

    // /api/feed — cross-origin from the dashboard.
    if (url.pathname === "/api/feed") {
      if (applyCors(req, res)) return;
      if (req.method === "GET") return json(res, 200, feed);
    }

    // /api/mode — cross-origin from the dashboard. Flips trust mode for
    // the whole server in-process. Preflight handled above; POST below.
    if (url.pathname === "/api/mode") {
      if (applyCors(req, res)) return;
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const next = body.mode;
        if (next !== "interactive" && next !== "autonomous" && next !== "learn") {
          return json(res, 400, { error: "mode must be one of: interactive, autonomous, learn" });
        }
        const prev = CONFIG.mode;
        CONFIG.mode = next as TrustMode;
        console.log(`  [MODE] runtime switch: ${prev} → ${next}`);
        return json(res, 200, { mode: CONFIG.mode, previous: prev });
      }
    }

    // Debug/test helper — exposes a session's live context by id. No auth;
    // returns only the in-memory slice. Keep simple — dashboard has
    // /api/session-log/:id for the full shape.
    if (req.method === "GET" && url.pathname.startsWith("/session/")) {
      const id = url.pathname.split("/session/")[1];
      return await handleSessionGet(res, id);
    }

    // ------ Hook events -------------------------------------------------
    if (req.method === "POST" && url.pathname === "/intent")   return await handleIntent(req, res);
    if (req.method === "POST" && url.pathname === "/register") return await handleRegister(req, res);
    if (req.method === "POST" && url.pathname === "/evaluate") return await handleEvaluate(req, res);
    if (req.method === "POST" && url.pathname === "/track")    return await handleTrack(req, res);
    if (req.method === "POST" && url.pathname === "/end")      return await handleEnd(req, res);
    if (req.method === "POST" && url.pathname === "/pivot")    return await handlePivot(req, res);
    if (req.method === "POST" && url.pathname === "/compact")  return await handleCompact(req, res);

    json(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      console.warn(`[413] ${req.method} ${url.pathname}: body exceeded ${err.bodyLimit} bytes`);
      return json(res, 413, { error: "Request body too large" });
    }
    if (err instanceof SyntaxError) {
      console.warn(`[400] ${req.method} ${url.pathname}: invalid JSON: ${err.message}`);
      return json(res, 400, { error: "Invalid JSON body" });
    }
    console.error(`[ERROR] ${req.method} ${url.pathname}:`, err);
    json(res, 500, { error: "Internal server error" });
  }
});

server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 5_000;

// =========================================================================
// Startup
// =========================================================================
export async function main() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  console.log("█".repeat(50));
  console.log(`  JUDGE AI DREDD — HOOK Server v${pkg.version}`);
  console.log("█".repeat(50));

  if (process.env.DREDD_SKIP_PREFLIGHT === "1") {
    console.warn("  [PREFLIGHT] skipped (DREDD_SKIP_PREFLIGHT=1) — test mode");
  } else {
    await interceptor.preflight();
  }
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
  console.log(`  Dashboard CORS:  ${DASHBOARD_ORIGIN || "(disabled — DREDD_DASHBOARD_ORIGIN unset)"}`);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  Listening on http://0.0.0.0:${PORT}`);
    console.log(`\n  Endpoints:`);
    console.log(`    POST /intent    — UserPromptSubmit (register intent)`);
    console.log(`    POST /evaluate  — PreToolUse (evaluate tool call)`);
    console.log(`    POST /track     — PostToolUse (record file/env state)`);
    console.log(`    POST /end       — Stop (write log, cleanup)`);
    console.log(`    POST /pivot     — explicit direction change`);
    console.log(`    POST /compact   — context compaction notification`);
    console.log(`    POST /api/mode  — runtime trust-mode switch`);
    console.log(`    GET  /health    — health check + version`);
    console.log(`    GET  /api/feed  — live event ring buffer (cross-origin)`);
    console.log("█".repeat(50));
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully");
    server.close(async () => {
      // Drain pending log lines to disk before exiting so the last
      // few seconds of activity (the SIGTERM, the close events) make
      // it into the daily file.
      await flushLogs();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  });
}
