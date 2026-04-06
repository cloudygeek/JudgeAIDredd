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
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionTracker } from "./session-tracker.js";
import { PreToolInterceptor } from "./pretool-interceptor.js";
import { checkOllama } from "./ollama-client.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3001" },
    "judge-model": { type: "string", default: "nemotron-3-super" },
    "embedding-model": { type: "string", default: "nomic-embed-text" },
    "review-threshold": { type: "string", default: "0.6" },
    "deny-threshold": { type: "string", default: "0.4" },
    "log-dir": { type: "string", default: "./results" },
  },
});

const PORT = parseInt(values.port!, 10);
const CONFIG = {
  judgeModel: values["judge-model"]!,
  embeddingModel: values["embedding-model"]!,
  reviewThreshold: parseFloat(values["review-threshold"]!),
  denyThreshold: parseFloat(values["deny-threshold"]!),
  logDir: values["log-dir"]!,
};

// Shared state
const tracker = new SessionTracker(CONFIG.embeddingModel);
const interceptor = new PreToolInterceptor({
  judgeModel: CONFIG.judgeModel,
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
// POST /intent — UserPromptSubmit
// =========================================================================
async function handleIntent(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { session_id, prompt } = body;

  if (!session_id || !prompt) {
    return json(res, 400, { error: "Missing session_id or prompt" });
  }

  const result = await tracker.registerIntent(session_id, prompt);

  // Register goal with interceptor on first call per session
  if (result.isOriginal && !registeredSessions.has(session_id)) {
    await interceptor.registerGoal(prompt);
    registeredSessions.add(session_id);
  }

  // Get appropriate reminder
  const reminder = tracker.getGoalReminder(session_id, result.driftFromOriginal);
  const classification = tracker.classifyDrift(result.driftFromOriginal);

  // Build hook response
  const hookResponse: Record<string, unknown> = {};

  if (reminder) {
    hookResponse.systemMessage = reminder;
  }

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
  const { session_id, tool_name, tool_input } = body;

  if (!session_id || !tool_name) {
    return json(res, 400, { error: "Missing session_id or tool_name" });
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

  const result = await interceptor.evaluate(tool_name, tool_input ?? {}, fileContext);

  // Record the decision
  tracker.recordToolCall(
    session_id,
    tool_name,
    tool_input ?? {},
    result.allowed ? "allow" : "deny",
    result.similarity
  );

  // Build hook response
  const hookResponse: Record<string, unknown> = {};

  if (!result.allowed) {
    const ctx = tracker.getSessionContext(session_id);
    hookResponse.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Judge Dredd: ${result.reason}`,
    };
    hookResponse.systemMessage =
      `[SECURITY] Tool call ${tool_name} was blocked. Reason: ${result.reason}. ` +
      `Stay focused on the original task: "${ctx.originalTask ?? "unknown"}".`;
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
    driftHistory,
    turnMetrics: summary.turnMetrics,
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
// Router
// =========================================================================
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        status: "ok",
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
  console.log("█".repeat(50));
  console.log("  JUDGE AI DREDD — HTTP Server");
  console.log("█".repeat(50));

  // Preflight
  await interceptor.preflight();
  console.log(`  Embedding model: ${CONFIG.embeddingModel}`);
  console.log(`  Judge model:     ${CONFIG.judgeModel}`);
  console.log(`  Thresholds:      review=${CONFIG.reviewThreshold}, deny=${CONFIG.denyThreshold}`);
  console.log(`  Log directory:   ${CONFIG.logDir}`);

  server.listen(PORT, () => {
    console.log(`\n  Listening on http://localhost:${PORT}`);
    console.log(`\n  Endpoints:`);
    console.log(`    POST /intent    — UserPromptSubmit (register intent)`);
    console.log(`    POST /evaluate  — PreToolUse (evaluate tool call)`);
    console.log(`    POST /track     — PostToolUse (record file/env state)`);
    console.log(`    POST /end       — Stop (write log, cleanup)`);
    console.log(`    GET  /health    — health check`);
    console.log(`    GET  /session/:id — session state (debug)`);
    console.log("█".repeat(50));
  });
}

main().catch(console.error);
