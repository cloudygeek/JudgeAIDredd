/**
 * Judge AI Dredd — shared server plumbing.
 *
 * This module holds everything both the hook container and the dashboard
 * container need at startup: CLI argument parsing, the console→file log
 * mirror, store/interceptor construction, request-body size caps,
 * session-id validation, path validation, hook-auth middleware, transcript
 * backfill, and the session-log shape builder used by the dashboard.
 *
 * Neither `server-hook.ts` nor `server-dashboard.ts` instantiates stores
 * directly — they import `tracker`, `apiKeys`, `interceptor` from here. The
 * dashboard container constructs all three too, even though it doesn't
 * call `interceptor.evaluate`, because the sessions listing reads
 * `interceptor.getLog()` for its per-session rendering.
 *
 * All module-level side effects (logger wiring, `[STORE]` / `[AUTH]`
 * startup prints) happen here exactly once per process.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, sep } from "node:path";
import { inspect } from "node:util";

// ============================================================================
// .env.local loader (local dev only)
// ============================================================================
//
// On the sandbox/Fargate deployment, secrets come from SSM via the task
// definition's `secrets` map — the env vars are already populated when this
// process starts. For local development we'd rather not require `export
// CLERK_SECRET_KEY=…` before every `npm run server`, so this block looks
// for `.env.local` in the project root and parses it into process.env.
//
// Behaviour:
//   - File missing → silent no-op.
//   - Key already set in process.env → not overwritten. The shell's
//     environment always wins so a one-off override stays a one-off.
//   - Lines starting with # are comments. Empty lines are skipped.
//   - Values may be quoted with single or double quotes; quotes are
//     stripped. No interpolation, no `export` prefix support — keep it
//     simple. If the format isn't enough, source the file from your
//     shell instead.
//
// `.env.local` is gitignored. NEVER commit secrets.
(() => {
  // Resolve relative to this source file so it works whether run from the
  // repo root or a different cwd (e.g. tsx invoked from /tmp).
  const candidates = [
    new URL("../.env.local", import.meta.url),
    new URL("../../.env.local", import.meta.url),
  ];
  for (const url of candidates) {
    let raw: string;
    try {
      raw = readFileSync(url, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    break;
  }
})();
import { InMemorySessionStore } from "./session-tracker.js";
import { DynamoSessionStore } from "./dynamo-session-store.js";
import { CachedSessionStore } from "./cached-session-store.js";
import type { SessionStore, ImageBlock, IntentEntry } from "./session-store.js";
import { MAX_ACTIVE_INTENTS, RESOLVED_INTENT_TTL_MS } from "./session-tracker.js";
import { embedAny, cosineSimilarity } from "./ollama-client.js";
import {
  type ApiKeyStore,
  InMemoryApiKeyStore,
} from "./api-key-store.js";
import { DynamoApiKeyStore } from "./dynamo-api-key-store.js";
import { CachedApiKeyStore } from "./cached-api-key-store.js";
import {
  type ApprovalStore,
  InMemoryApprovalStore,
} from "./approval-store.js";
import { DynamoApprovalStore } from "./dynamo-approval-store.js";
import { CachedApprovalStore } from "./cached-approval-store.js";
import {
  type UserPermissionsStore,
  InMemoryUserPermissionsStore,
} from "./user-permissions-store.js";
import { DynamoUserPermissionsStore } from "./dynamo-user-permissions-store.js";
import { pruneExpiredPendingApprovals } from "./pending-approvals.js";
import { PreToolInterceptor } from "./pretool-interceptor.js";
import type { PromptVariant } from "./intent-judge.js";

export type TrustMode = "interactive" | "autonomous" | "learn";

// ============================================================================
// CLI parsing + CONFIG
// ============================================================================

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

// File logger — mirrors all console output to dredd-YYYY-MM-DD.log.
//
// Why this isn't appendFileSync: every console.* call would block the
// Node event loop while EFS round-trips the write (20-50ms p99 cold).
// Hot paths log on every hook event, so the cumulative cost was real.
//
// Replaced with an in-process queue + a single fs.WriteStream-backed
// drainer running on the next tick. Public API stays the same — the
// console overrides below call enqueueLogLine() and return immediately;
// the line eventually lands on disk asynchronously.
//
// Backpressure: drops newest writes once the queue exceeds the cap
// (default 10k lines). Hitting that cap means EFS is so slow we'd
// rather lose recent log lines than OOM the container. Drops are
// counted and surfaced once per minute via stderr so operators can see.
//
// Rotation: rolls over when the date changes (UTC midnight) OR the
// current file exceeds MAX_FILE_BYTES. The rolled file is renamed to
// dredd-YYYY-MM-DD.<seq>.log so the active filename always sorts last
// for the day.
//
// Shutdown: SIGTERM in main() awaits flushLogs() before exiting so
// in-flight log lines reach disk.
const LOG_DIR = values["console-log-dir"]!;
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const MAX_QUEUE_LINES = 10_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB before forced rotation
const DROP_REPORT_INTERVAL_MS = 60_000;

let logQueue: string[] = [];
let logStream: ReturnType<typeof createWriteStream> | null = null;
let logStreamPath: string | null = null;
let logStreamBytes = 0;
let logDraining = false;
let droppedLines = 0;
let lastDropReport = 0;

function currentLogPath(): string {
  // Date in UTC so all containers in the fleet roll at the same instant.
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `dredd-${date}.log`);
}

function ensureStream(): void {
  const desired = currentLogPath();
  // Date changed (midnight UTC) — rotate by closing and reopening.
  if (logStream && logStreamPath !== desired) {
    try { logStream.end(); } catch {}
    logStream = null;
    logStreamPath = null;
    logStreamBytes = 0;
  }
  // Size exceeded — rotate to dredd-YYYY-MM-DD.<n>.log so the active
  // file remains dredd-YYYY-MM-DD.log.
  if (logStream && logStreamBytes >= MAX_FILE_BYTES && logStreamPath) {
    try { logStream.end(); } catch {}
    let n = 1;
    while (existsSync(`${logStreamPath}.${n}`)) n++;
    try { renameSync(logStreamPath, `${logStreamPath}.${n}`); } catch {}
    logStream = null;
    logStreamBytes = 0;
  }
  if (!logStream) {
    logStream = createWriteStream(desired, { flags: "a" });
    logStream.on("error", () => {
      // Silently abandon a broken stream so future writes can re-open
      // on the next ensureStream tick. Crashing the logger must never
      // crash the process.
      logStream = null;
      logStreamPath = null;
      logStreamBytes = 0;
    });
    logStreamPath = desired;
    // Best-effort starting size for rotation accounting.
    try { logStreamBytes = statSync(desired).size; } catch { logStreamBytes = 0; }
  }
}

function reportDropsIfNeeded(): void {
  if (droppedLines === 0) return;
  const now = Date.now();
  if (now - lastDropReport < DROP_REPORT_INTERVAL_MS) return;
  // Use process.stderr.write directly so we don't recurse through the
  // console override.
  process.stderr.write(`[logger] dropped ${droppedLines} log lines (queue full)\n`);
  droppedLines = 0;
  lastDropReport = now;
}

function drainLogs(): void {
  if (logDraining || logQueue.length === 0) return;
  logDraining = true;
  // setImmediate so we don't recurse inside the console override and so
  // multiple synchronous console calls coalesce into one drain.
  setImmediate(() => {
    try {
      ensureStream();
      if (!logStream) {
        logQueue.length = 0;
        return;
      }
      const batch = logQueue;
      logQueue = [];
      const payload = batch.join("");
      logStreamBytes += Buffer.byteLength(payload, "utf8");
      logStream.write(payload);
    } finally {
      logDraining = false;
      reportDropsIfNeeded();
      // If more arrived while we were draining, keep going.
      if (logQueue.length > 0) drainLogs();
    }
  });
}

function enqueueLogLine(line: string): void {
  if (logQueue.length >= MAX_QUEUE_LINES) {
    droppedLines++;
    return;
  }
  logQueue.push(line);
  if (!logDraining) drainLogs();
}

/**
 * Flush pending log lines and close the stream. Awaited on SIGTERM so
 * in-flight logs reach disk before the process exits. Bounded by a 5s
 * timeout — if the stream is wedged, exit anyway.
 */
export async function flushLogs(): Promise<void> {
  if (logQueue.length === 0 && !logStream) return;
  // Force one final drain.
  drainLogs();
  // Wait for the queue to empty.
  const start = Date.now();
  while (logQueue.length > 0 && Date.now() - start < 5_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // Close the stream and wait for the close event.
  if (logStream) {
    const stream = logStream;
    logStream = null;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      stream.once("close", done);
      stream.once("error", done);
      stream.end();
      // Hard cap in case end() never fires.
      setTimeout(done, 2_000);
    });
  }
}

// Prepend ISO timestamp to every console line so server logs are grep/sortable,
// and also write to the daily log file (asynchronously, see above).
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const timestamp = `[${new Date().toISOString()}]`;
    original(timestamp, ...args);
    const parts = args.map(a => typeof a === "string" ? a : inspect(a, { depth: 4, breakLength: Infinity }));
    enqueueLogLine(`${timestamp} ${parts.join(" ")}\n`);
  };
}

export const PORT = parseInt(values.port!, 10);

export const CONFIG = {
  mode: (values.mode as TrustMode) ?? "autonomous",
  judgeModel: values["judge-model"]!,
  judgeBackend: (values.backend as "ollama" | "bedrock")!,
  embeddingModel: values["embedding-model"]!,
  hardened: ((): PromptVariant | false => {
    const p = (values.prompt as string).trim();
    if (p === "B7" || p === "B7.1" || p === "B7.1-office") return p;
    if (p === "standard" || p === "") return values.hardened ? "B7.1" : false;
    throw new Error(`Unknown --prompt variant "${p}" (want: standard, B7, B7.1, B7.1-office)`);
  })(),
  judgeEffort: (values["judge-effort"] as string).trim() || undefined,
  reviewThreshold: parseFloat(values["review-threshold"]!),
  denyThreshold: parseFloat(values["deny-threshold"]!),
  hijackThreshold: Math.max(1, parseInt(values["hijack-threshold"]!, 10) || 2),
  logDir: values["log-dir"]!,
  consoleLogDir: LOG_DIR,
};

// ============================================================================
// Shared feed ring buffer
// ============================================================================
//
// Only populated on the hook container — the dashboard container reads it
// cross-origin from DREDD_HOOK_URL/api/feed. Kept here because tests and
// benchmark harnesses used to exercise the feed directly.

export type FeedEntry = {
  timestamp: string;
  type: string;
  tool?: string;
  stage?: string;
  allowed?: boolean;
  reason?: string;
  prompt?: string;
  sessionId?: string;
  /** Null = caller did not present a key (pre-auth or auth off). */
  ownerSub?: string | null;
  /** "unauthenticated" (no key) / "bad-key" (present but invalid). */
  authStage?: string | null;
  /**
   * Interactive/learn intent stack classification for this turn —
   * "original" / "queued" / "confirmation" / "new-task" / "continuation"
   * / "open-followup" / "sub-task" / "replacement" / "revisit". Absent
   * on autonomous-mode entries. Lets the dashboard live feed mark each
   * /intent with a badge showing whether the goal was appended or
   * replaced.
   */
  intentKind?: string;
  /** Stack length after this update, when applicable. */
  intentStackSize?: number;
  /** Step 4 telemetry (history-active model). Set on type="intent-classify"
   *  entries that record the embedding-fallback verdict and on
   *  type="intent-classify-llm" entries that record the async LLM verdict
   *  + whether it overrode the embedding decision.
   *
   *  classifierSource — which classifier produced this entry's kind.
   *  classifierConfidence — LLM's stated confidence; absent for embedding.
   *  classifierLatencyMs — round-trip time for the LLM call.
   *  classifierOverridden — true when the LLM overruled the embedding.
   *  classifierEmbeddingKind — what the embedding fallback said (only
   *    set when LLM disagreed, so the dashboard can show before/after).
   */
  classifierSource?: "embedding" | "llm" | "llm-confirmed" | "embedding-fallback-timeout";
  classifierConfidence?: "high" | "medium" | "low";
  classifierLatencyMs?: number;
  classifierOverridden?: boolean;
  classifierEmbeddingKind?: string;
  /** Phase 4: which of the user's local permission rules matched this
   *  tool call, if any. kind="deny" means the call was short-circuited
   *  by the user's deny list (stage = "user-deny"); kind="allow" is a
   *  pure annotation that doesn't change the verdict. Set on
   *  type="tool" entries; absent when the user has no lists or no rule
   *  matched. Drives the Phase 5 dashboard side-badge. */
  userPermission?: { kind: "allow" | "deny"; rule: string };
  /** Phase 8b: pattern-trust learning signal. Set when the interceptor
   *  found prior approvals similar enough to inform / short-circuit
   *  this decision. hard=true → short-circuit to pattern-trust-allow;
   *  hard=false → judge was given soft context but verdict unchanged. */
  patternTrust?: { hard: boolean; matched: number; topSim: number; topSummary: string };
};

export const feed: FeedEntry[] = [];
/**
 * In-memory feed ring buffer. Holds the most recent N events for the
 * dashboard's live view. Bumped from 200 to 2000 (~1MB at typical
 * entry size) so a busy session — multi-turn agent with frequent
 * /evaluate calls — doesn't push intent events off the buffer
 * before an operator can investigate.
 */
const MAX_FEED = 2000;

/**
 * Per-day on-disk feed log. Every addFeed call appends one JSONL line
 * to dredd-feed-YYYY-MM-DD.log alongside the existing console log,
 * so the operator can query historical events that have rolled out
 * of the in-memory ring. Best-effort; a write failure is logged once
 * per day to avoid spam but does not block the in-memory append.
 */
function feedLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `dredd-feed-${date}.log`);
}
let feedLogWriteFailedToday = "";
function persistFeedEntry(entry: FeedEntry): void {
  try {
    appendFileSync(feedLogPath(), JSON.stringify(entry) + "\n");
  } catch (err) {
    const date = new Date().toISOString().slice(0, 10);
    if (feedLogWriteFailedToday !== date) {
      feedLogWriteFailedToday = date;
      console.warn(
        `[feed-log] failed to append to ${feedLogPath()}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

export function addFeed(entry: FeedEntry) {
  const stamped = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
  feed.push(stamped);
  if (feed.length > MAX_FEED) feed.splice(0, feed.length - MAX_FEED);
  persistFeedEntry(stamped);
}

// ============================================================================
// Notification counters — in-memory, per-session.
// ============================================================================
//
// Counts how many times Claude Code surfaced a permission/notification prompt
// to the user in a given session. Populated by the hook container's
// /notification handler. Lives in-process: a Fargate task replacement
// resets it. That's acceptable for the friction-measurement use case
// (A/B harness reads the counter shortly after the run ends and sticky
// cookies pin a session to one task for its lifetime). If we ever need
// durability we can replicate the existing addFeed → Dynamo pattern.

export const notificationCounts: Map<string, number> = new Map();

export function recordNotification(sessionId: string): number {
  const next = (notificationCounts.get(sessionId) ?? 0) + 1;
  notificationCounts.set(sessionId, next);
  return next;
}

export function getNotificationCount(sessionId: string): number {
  return notificationCounts.get(sessionId) ?? 0;
}

// ============================================================================
// Stores
// ============================================================================

export const STORE_BACKEND = (process.env.STORE_BACKEND ?? "memory") as "memory" | "dynamo";
export const DYNAMO_TABLE_NAME = process.env.DYNAMO_TABLE_NAME ?? "jaid-sessions";
export const DYNAMO_REGION = process.env.DYNAMO_REGION ?? process.env.AWS_REGION ?? "eu-west-1";

export const tracker: SessionStore = STORE_BACKEND === "dynamo"
  ? new CachedSessionStore({
      backend: new DynamoSessionStore({
        tableName: DYNAMO_TABLE_NAME,
        region: DYNAMO_REGION,
        embeddingModel: CONFIG.embeddingModel,
      }),
      embeddingModel: CONFIG.embeddingModel,
    })
  : new InMemorySessionStore(CONFIG.embeddingModel);

console.log(
  `  [STORE] Backend: ${STORE_BACKEND}` +
    (STORE_BACKEND === "dynamo"
      ? ` (table=${DYNAMO_TABLE_NAME}, region=${DYNAMO_REGION})`
      : ""),
);

export const DYNAMO_API_KEYS_TABLE_NAME =
  process.env.DYNAMO_API_KEYS_TABLE_NAME ?? "jaid-api-keys";

export const apiKeys: ApiKeyStore = STORE_BACKEND === "dynamo"
  ? new CachedApiKeyStore({
      backend: new DynamoApiKeyStore({
        tableName: DYNAMO_API_KEYS_TABLE_NAME,
        region: DYNAMO_REGION,
      }),
    })
  : new InMemoryApiKeyStore();

console.log(
  `  [AUTH]  API-key store: ${STORE_BACKEND}` +
    (STORE_BACKEND === "dynamo"
      ? ` (table=${DYNAMO_API_KEYS_TABLE_NAME}, region=${DYNAMO_REGION})`
      : ""),
);

// ---- approval store -------------------------------------------------------
// Durable "learning" of user-approved tool calls. Dynamo wiring is added in
// the DynamoApprovalStore task; until then the in-memory store gives us a
// working local-dev path without a second deploy.

export const DYNAMO_APPROVALS_TABLE_NAME =
  process.env.DYNAMO_APPROVALS_TABLE_NAME ?? "jaid-approvals";

export const approvals: ApprovalStore = STORE_BACKEND === "dynamo"
  ? new CachedApprovalStore({
      backend: new DynamoApprovalStore({
        tableName: DYNAMO_APPROVALS_TABLE_NAME,
        region: DYNAMO_REGION,
      }),
    })
  : new InMemoryApprovalStore();

console.log(
  `  [APPRV] Approval store: ${STORE_BACKEND}` +
    (STORE_BACKEND === "dynamo"
      ? ` (table=${DYNAMO_APPROVALS_TABLE_NAME}, region=${DYNAMO_REGION})`
      : ""),
);

// ---- user-permissions store ----------------------------------------------
// Per-(user, project) snapshot of the user's local Claude Code allow/deny/
// ask lists, uploaded by the hook. /intent does the cross-session lookup
// against this; the session META gets a copy so /evaluate doesn't have to.

export const DYNAMO_USER_PERMISSIONS_TABLE_NAME =
  process.env.DYNAMO_USER_PERMISSIONS_TABLE_NAME ?? "jaid-user-permissions";

export const userPermissions: UserPermissionsStore = STORE_BACKEND === "dynamo"
  ? new DynamoUserPermissionsStore({
      tableName: DYNAMO_USER_PERMISSIONS_TABLE_NAME,
      region: DYNAMO_REGION,
    })
  : new InMemoryUserPermissionsStore();

console.log(
  `  [USERPERM] User-permissions store: ${STORE_BACKEND}` +
    (STORE_BACKEND === "dynamo"
      ? ` (table=${DYNAMO_USER_PERMISSIONS_TABLE_NAME}, region=${DYNAMO_REGION})`
      : ""),
);

// Phase 6 rollout gate. When false (default), the hook can still upload
// snapshots and the dashboard can still surface them, but the PreToolUse
// pipeline does NOT consult them — user-deny short-circuit and user-allow
// annotation are both skipped in handlers/evaluate.ts. Flip to "true"
// once the upload path has soaked.
export const USER_PERMISSIONS_ENFORCED =
  (process.env.DREDD_USER_PERMISSIONS_ENABLED ?? "false").toLowerCase() === "true";
console.log(
  `  [USERPERM] Pipeline enforcement: ${USER_PERMISSIONS_ENFORCED ? "ON" : "OFF (rollout)"}`,
);

// Phase 8b rollout. Umbrella controls whether the interceptor reads
// prior approvals at /evaluate at all (a Dynamo Query per call when on).
// When the umbrella is on:
//   - SOFT path always runs: top matches are stitched into the judge
//     prompt as evidence of legitimate intent. Verdict unchanged.
//   - HARD path runs only when the second flag is also true:
//     ≥ HARD_MIN_COUNT matches at HARD_THRESHOLD short-circuit to
//     stage="pattern-trust-allow" before Stage 1 policy — overrides
//     Dredd's hard denies (rm -rf etc) by design.
export const PATTERN_LEARNING_ENABLED =
  (process.env.DREDD_PATTERN_LEARNING_ENABLED ?? "false").toLowerCase() === "true";
export const PATTERN_LEARNING_HARD =
  PATTERN_LEARNING_ENABLED &&
  (process.env.DREDD_PATTERN_LEARNING_HARD_ENABLED ?? "false").toLowerCase() === "true";
console.log(
  `  [PATTRN] Pattern-trust learning: ${PATTERN_LEARNING_ENABLED
    ? `ON (soft${PATTERN_LEARNING_HARD ? " + hard" : ""})`
    : "OFF (rollout)"}`,
);

// Periodically purge expired pending-approval candidates (the 60s
// window between an "ask" and the user's accept/deny). Cheap, keeps
// the in-process map from growing unbounded under abandoned prompts.
setInterval(() => {
  pruneExpiredPendingApprovals();
}, 30_000).unref();

export const interceptor = new PreToolInterceptor({
  judgeModel: CONFIG.judgeModel,
  judgeBackend: CONFIG.judgeBackend,
  embeddingModel: CONFIG.embeddingModel,
  reviewThreshold: CONFIG.reviewThreshold,
  denyThreshold: CONFIG.denyThreshold,
  hardened: CONFIG.hardened,
  judgeEffort: CONFIG.judgeEffort as any,
});

/** Sessions whose goal has been registered with the interceptor.
 *  Hook container populates; dashboard container imports it to render
 *  interceptor log entries (getLog) on session detail views. */
export const registeredSessions = new Set<string>();

// ============================================================================
// readBody + body caps
// ============================================================================

export const BODY_LIMIT_DEFAULT = 1 * 1024 * 1024;       // 1 MB
export const BODY_LIMIT_TRANSCRIPT = 20 * 1024 * 1024;   // 20 MB

export class BodyTooLargeError extends Error {
  readonly bodyLimit: number;
  constructor(limit: number) {
    super(`Request body exceeded ${limit} bytes`);
    this.name = "BodyTooLargeError";
    this.bodyLimit = limit;
  }
}

export async function readBody(req: IncomingMessage, maxBytes = BODY_LIMIT_DEFAULT): Promise<string> {
  const declared = req.headers["content-length"];
  if (declared) {
    const n = parseInt(declared, 10);
    if (!Number.isNaN(n) && n > maxBytes) throw new BodyTooLargeError(maxBytes);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      req.destroy();
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ============================================================================
// session_id validation
// ============================================================================

export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidSessionId(v: unknown): v is string {
  return typeof v === "string" && SESSION_ID_PATTERN.test(v);
}

export function rejectInvalidSessionId(res: ServerResponse, sessionId: unknown): sessionId is never {
  if (isValidSessionId(sessionId)) return false;
  json(res, 400, {
    error: "Invalid session_id",
    detail: `Must match ${SESSION_ID_PATTERN} (alphanumeric, dot, dash, underscore; 1–128 chars)`,
  });
  return true;
}

// ============================================================================
// Filesystem path validation
// ============================================================================

const ALLOW_ANY_PATH = process.env.DREDD_ALLOW_ANY_PATH === "1";

export function isSafeServerReadablePath(p: unknown): p is string {
  if (ALLOW_ANY_PATH) return typeof p === "string";
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) return false;
  if (p.includes("\0")) return false;
  let resolved: string;
  try {
    resolved = realpathSync(p);
  } catch {
    return false;
  }
  const marker = `${sep}.claude${sep}`;
  const normalised = resolved.endsWith(sep) ? resolved : resolved + sep;
  return normalised.includes(marker);
}

export function safeServerReadablePath(p: unknown): string | null {
  return isSafeServerReadablePath(p) ? p : null;
}

// ============================================================================
// Hook authentication
// ============================================================================

type AuthMode = "off" | "optional" | "required";
// Default "required" — every hook caller must present a valid Bearer
// API key. Set DREDD_AUTH_MODE=optional explicitly during a rollout
// where some clients don't have keys yet, or =off in dev.
export const AUTH_MODE: AuthMode = ((process.env.DREDD_AUTH_MODE ?? "required") as AuthMode);
if (AUTH_MODE !== "off" && AUTH_MODE !== "optional" && AUTH_MODE !== "required") {
  throw new Error(
    `Invalid DREDD_AUTH_MODE=${process.env.DREDD_AUTH_MODE} — expected off|optional|required`,
  );
}
console.log(`  [AUTH]  Mode: ${AUTH_MODE}`);

export interface RequestIdentity {
  ownerSub: string | null;
  ownerEmail: string | null;
  keyType: "user" | "service" | "benchmark" | null;
  keyPresented: boolean;
  keyValid: boolean;
}

const ANON: RequestIdentity = { ownerSub: null, ownerEmail: null, keyType: null, keyPresented: false, keyValid: false };

function extractBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

export async function authenticateHookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RequestIdentity | null> {
  if (AUTH_MODE === "off") return ANON;

  const token = extractBearer(req);
  if (!token) {
    if (AUTH_MODE === "required") {
      json(res, 401, {
        error: "Missing API key",
        detail: "Send Authorization: Bearer <jaid_live_...>. " +
                "Generate one from the dashboard Settings → API Keys.",
      });
      return null;
    }
    return { ...ANON };
  }

  const validated = await apiKeys.validateKey(token).catch((err) => {
    console.error(`[AUTH] validateKey error: ${err instanceof Error ? err.message : err}`);
    return null;
  });

  if (!validated) {
    if (AUTH_MODE === "required") {
      json(res, 401, {
        error: "Invalid or revoked API key",
        detail: "Key does not match the expected format or has been revoked. " +
                "Generate a new one from the dashboard.",
      });
      return null;
    }
    return { ownerSub: null, ownerEmail: null, keyType: null, keyPresented: true, keyValid: false };
  }

  return {
    ownerSub: validated.ownerSub,
    ownerEmail: validated.ownerEmail,
    keyType: validated.keyType,
    keyPresented: true,
    keyValid: true,
  };
}

export function authStageForFeed(identity: RequestIdentity): string | null {
  if (!identity.keyPresented) return "unauthenticated";
  if (!identity.keyValid) return "bad-key";
  return null;
}

// ============================================================================
// Misc helpers
// ============================================================================

/** Derive the caller-visible origin behind an ALB / reverse proxy. */
export function resolvePublicOrigin(req: IncomingMessage): string {
  const xfProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const xfHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const host = xfHost || req.headers.host || `localhost:${PORT}`;
  const proto = xfProto || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

// ============================================================================
// Transcript backfill — extracted to ./transcript-backfill.ts
// Re-exported for backwards compatibility with existing import sites,
// and re-imported below for use within server-core's intent-stack
// section (buildContextualIntent, isSyntheticUserEntry, etc.).
// ============================================================================
export {
  isConfirmationPrompt,
  extractImagesFromContentBlocks,
  extractTextAndImages,
  isSyntheticUserEntry,
  extractLastUserAndPriorAssistant,
  sanitiseFenceTags,
  buildContextualIntent,
} from "./transcript-backfill.js";

import {
  extractTextAndImages,
  isSyntheticUserEntry,
  extractLastUserAndPriorAssistant,
  buildContextualIntent,
} from "./transcript-backfill.js";

import { deriveTurnState } from "./intent-stack.js";

// ============================================================================
// Interactive/learn intent stack — extracted to ./intent-stack.ts
// Re-exported for backwards compatibility (server-hook + intent-classifier
// reference CONTINUATION_DRIFT_MAX, NEW_TASK_DRIFT_MIN,
// applyIntentStackUpdate, deriveTurnState, etc.).
// ============================================================================
export {
  CONTINUATION_DRIFT_MAX,
  NEW_TASK_DRIFT_MIN,
  SUB_TASK_DRIFT_MAX,
  REVISIT_SIMILARITY_MIN,
  describePhrasingMatches,
  deriveTurnState,
  classifyIntentByEmbedding,
  applyIntentStackUpdate,
  applyClassifierOverride,
  backfillFromSummary,
  backfillFromTranscript,
} from "./intent-stack.js";
export type {
  TurnState,
  EmbeddingClassifierVerdict,
  IntentStackUpdateResult,
  TranscriptSummary,
} from "./intent-stack.js";

// ============================================================================
// buildSessionLogShape — used by dashboard /api/sessions and /api/session-log
// ============================================================================

/**
 * Assemble the full session-log JSON shape the dashboard consumes.
 * Works for both live sessions (in-memory tracker) and persisted sessions
 * in Dynamo. Returns null when the session is completely unknown.
 */
export async function buildSessionLogShape(sessionId: string): Promise<Record<string, unknown> | null> {
  const state = await tracker.loadSession(sessionId);
  if (!state || (!state.originalIntent && state.currentTurn === 0 && state.turnIntents.length === 0)) {
    return null;
  }
  const summary = await tracker.getFullSessionSummary(sessionId);
  const driftHistory = tracker.getDriftDetector(sessionId).getHistory();
  // Goal history — every user prompt that registered an intent. The original
  // (turn 0) is stored separately on SessionState; prepend it so the
  // dashboard's Goals view shows the first prompt alongside subsequent
  // turns. Embeddings are stripped (large, server-side only).
  const allIntents = state.originalIntent
    ? [state.originalIntent, ...state.turnIntents]
    : state.turnIntents;
  // Latest non-confirmation prompt is the "current task" the dashboard
  // displays at the top of the detail view. Falls back to the original
  // prompt when no subsequent non-confirmation has registered.
  let currentTask: string | null = state.originalIntent?.prompt ?? null;
  for (let i = state.turnIntents.length - 1; i >= 0; i--) {
    if (!state.turnIntents[i].isConfirmation) {
      currentTask = state.turnIntents[i].prompt;
      break;
    }
  }
  // Active intent stack (interactive/learn). The wire shape strips the
  // 1024-dim embedding (server-only) but keeps the kind/resolved flags
  // so the dashboard can render append vs replace decisions distinctly
  // from the noisier per-turn intent log.
  const activeIntents = (state.activeIntents ?? []).map((e) => ({
    prompt: e.prompt,
    kind: e.kind,
    resolved: e.resolved,
    registeredAt: e.registeredAt,
    hasImages: !!e.images?.length,
  }));

  return {
    sessionId,
    timestamp: new Date().toISOString(),
    originalTask: state.originalIntent?.prompt ?? null,
    currentTask,
    summary,
    hijackStrikes: state.hijackStrikes,
    lockedHijacked: state.lockedHijacked,
    toolHistory: state.toolHistory,
    activeIntents,
    turnState: deriveTurnState({
      prevUserPromptAt: state.lastUserPromptAt,
      prevPreToolUseAt: state.lastPreToolUseAt,
      prevStopAt: state.lastStopAt,
    }),
    turnIntents: allIntents.map((t) => ({
      turnNumber: t.turnNumber,
      timestamp: t.timestamp,
      prompt: t.prompt,
      isConfirmation: t.isConfirmation ?? false,
      hasImages: !!t.images?.length,
    })),
    filesWritten: (await tracker.getWrittenFiles(sessionId)).map((f) => ({
      path: f.path,
      writeCount: f.writeCount,
      containsCanary: f.containsCanary,
    })),
    envVars: await tracker.getEnvVars(sessionId),
    driftHistory,
    turnMetrics: summary.turnMetrics,
    // Snapshot of the user's local Claude allow/deny/ask lists copied
    // in from jaid-user-permissions at /intent time. Drives the Phase 5
    // "User Permissions" section on the session-detail page. Null when
    // the hook hasn't uploaded any settings for this session.
    userPermissions: state.userPermissions ?? null,
    interceptorLog: interceptor.getLog(sessionId).map((r) => ({
      tool: r.tool,
      input: r.input,
      stage: r.stage,
      allowed: r.allowed,
      similarity: r.similarity,
      reason: r.reason,
      evaluationMs: r.evaluationMs,
      userPermissionMatch: r.userPermissionMatch,
    })),
  };
}
