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
import { MAX_INTENT_STACK, MAX_ACTIVE_INTENTS, RESOLVED_INTENT_TTL_MS } from "./session-tracker.js";
import { embedAny, cosineSimilarity } from "./ollama-client.js";
import {
  type ApiKeyStore,
  InMemoryApiKeyStore,
} from "./api-key-store.js";
import { DynamoApiKeyStore } from "./dynamo-api-key-store.js";
import { CachedApiKeyStore } from "./cached-api-key-store.js";
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
};

export const feed: FeedEntry[] = [];
const MAX_FEED = 200;

export function addFeed(entry: FeedEntry) {
  feed.push({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() });
  if (feed.length > MAX_FEED) feed.splice(0, feed.length - MAX_FEED);
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
export const AUTH_MODE: AuthMode = ((process.env.DREDD_AUTH_MODE ?? "optional") as AuthMode);
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
// Transcript backfill (hook-side only; exported for server-hook.ts)
// ============================================================================

export function isConfirmationPrompt(text: string): boolean {
  return (
    /^\s*(yes|yeah|yep|ok|okay|sure|do it|go ahead|go|proceed|continue|y|k|confirm|approved?|lgtm|ship it|sounds good|that's right|correct|exactly|please|thanks|thank you|option\s+\w+|👍)\b/i.test(text)
    && text.trim().length < 80
  );
}

export function extractImagesFromContentBlocks(blocks: any[]): ImageBlock[] {
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

export function extractTextAndImages(content: unknown): { text: string; images: ImageBlock[] } {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
    return { text, images: extractImagesFromContentBlocks(content) };
  }
  return { text: "", images: [] };
}

export function isSyntheticUserEntry(msg: any, text: string): boolean {
  if (msg?.isMeta === true) return true;
  const t = text.trim();
  if (!t) return false;
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<command-args>")
  );
}

export function extractLastUserAndPriorAssistant(
  transcriptPathOrContent: string,
  isContent = false
): { lastUser: string | null; priorAssistant: string | null; images: ImageBlock[] } {
  let raw: string;
  if (isContent) {
    raw = transcriptPathOrContent;
  } else {
    const safe = safeServerReadablePath(transcriptPathOrContent);
    if (!safe) {
      return { lastUser: null, priorAssistant: null, images: [] };
    }
    try {
      raw = readFileSync(safe, "utf8");
    } catch {
      return { lastUser: null, priorAssistant: null, images: [] };
    }
  }
  try {
    const lines = raw.trim().split("\n").filter(Boolean);
    const userTurns: { user: string; prior: string | null; images: ImageBlock[] }[] = [];
    let pendingAssistant: string | null = null;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant") {
          const { text } = extractTextAndImages(msg.message?.content);
          const trimmed = text.trim();
          if (trimmed) pendingAssistant = trimmed;
        } else if (msg.type === "user") {
          const { text, images: imgs } = extractTextAndImages(msg.message?.content);
          const trimmed = text.trim();
          if (isSyntheticUserEntry(msg, trimmed)) continue;
          if (trimmed || imgs.length) {
            userTurns.push({ user: trimmed, prior: pendingAssistant, images: imgs });
          }
        }
      } catch {}
    }

    if (userTurns.length === 0) return { lastUser: null, priorAssistant: null, images: [] };

    for (let i = userTurns.length - 1; i >= 0; i--) {
      if (!isConfirmationPrompt(userTurns[i].user)) {
        return { lastUser: userTurns[i].user, priorAssistant: userTurns[i].prior, images: userTurns[i].images };
      }
    }
    const last = userTurns[userTurns.length - 1];
    return { lastUser: last.user, priorAssistant: last.prior, images: last.images };
  } catch {
    return { lastUser: null, priorAssistant: null, images: [] };
  }
}

/**
 * Tag names we use to fence trusted vs untrusted content in the judge
 * prompt. If any of these appear in caller-supplied text (assistant or
 * user) they are stripped before reaching the prompt — otherwise an
 * attacker could close the tag, inject directives in what the model
 * sees as the system context, and reopen.
 *
 * Keep this list in sync with the tags actually used in
 *   - this file's buildContextualIntent (<prior_assistant_response>, <user_prompt>)
 *   - intent-judge.ts evaluate() (<user_intent>, <actions>, <action>)
 */
const FENCE_TAG_NAMES = [
  "user_intent",
  "user_prompt",
  "prior_assistant_response",
  "actions",
  "action",
] as const;

/**
 * Match any open or close tag matching one of the fence tag names,
 * tolerating whitespace and case. Replaced with [REDACTED:fence-tag]
 * to neutralise delimiter-injection attempts.
 */
const FENCE_TAG_RE = new RegExp(
  `<\\s*/?\\s*(?:${FENCE_TAG_NAMES.join("|")})\\s*>`,
  "gi",
);

/**
 * Patterns that, when found in untrusted assistant text, are nuked before
 * reaching the judge prompt. Defence-in-depth alongside the system-prompt
 * "treat as data" directive — even if the model misinterprets the
 * directive, the obvious injection attempts never reach it.
 *
 * Each pattern matches a phrase commonly used in prompt-injection PoCs;
 * the redaction marker preserves token count roughly so the surrounding
 * context still reads naturally.
 *
 * NOT applied to user prompts (those are trusted input). Only used by
 * sanitiseAssistantContent below. Fence-tag scrubbing IS applied to user
 * prompts separately by sanitiseFenceTags.
 */
const INJECTION_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?|system|directives?)/gi, reason: "ignore-previous" },
  { re: /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?|system|directives?)/gi, reason: "disregard-previous" },
  { re: /(you\s+are\s+now|from\s+now\s+on,?\s+you\s+(are|will|must))\b/gi, reason: "role-override" },
  { re: /<\s*\/?\s*(system|admin|root|sudo)\s*>/gi, reason: "fake-tag" },
  { re: /\[\s*(system|admin|root|sudo)\s*\]/gi, reason: "fake-bracket" },
  { re: /regardless\s+of\s+(any|all|other|previous|prior)\s+(instructions?|rules?|directives?|context)/gi, reason: "regardless-of" },
  { re: /(respond|reply|answer|return|output)[\s:]+(only|exclusively|with)?\s*(the\s+)?(json|word|verdict|consistent|drifting|hijacked)/gi, reason: "force-output" },
  { re: /(classify|judge|treat|mark|consider)\s+(all|every|any|the\s+following)\s+(subsequent|next|following|further)\s+(tool|action|call|request)/gi, reason: "classify-subsequent" },
  { re: /important:\s*(regardless|ignore|disregard|always|never)/gi, reason: "important-override" },
  { re: /(your\s+)?(only\s+)?(real\s+)?(true\s+)?(actual\s+)?(real\s+)?(task|job|goal|objective)\s+is\s+(to\s+)?(now\s+)?(actually\s+)?(really\s+)?(?=\w)/gi, reason: "task-override" },
];

/**
 * Strip any fence-tag (open or close) we use to delimit untrusted content
 * in the judge prompt. Applied to BOTH user prompts and assistant text
 * because the attacker doesn't need to be the LLM to inject delimiters —
 * a user could paste text containing `</user_intent>` from a previous
 * conversation log too.
 *
 * Exported so server-hook can scrub the user prompt before it's wrapped.
 */
export function sanitiseFenceTags(text: string): string {
  return text.replace(FENCE_TAG_RE, "[REDACTED:fence-tag]");
}


/**
 * Strip obvious instruction-injection patterns AND fence-tag delimiters
 * from untrusted assistant text. Preserves length-ish by replacing with
 * `[REDACTED:reason]`. The fence-tag scrubbing is critical — the
 * judge prompt fences this content with `<prior_assistant_response>` /
 * `<user_intent>` etc., and a malicious assistant that closes the tag
 * could reopen as system context. The instruction-pattern scrubbing is
 * belt-and-braces for the obvious injection vectors.
 */
function sanitiseAssistantContent(text: string): string {
  let out = sanitiseFenceTags(text);
  for (const { re, reason } of INJECTION_PATTERNS) {
    out = out.replace(re, `[REDACTED:${reason}]`);
  }
  return out;
}

/**
 * Combine a user prompt with prior assistant context into the judge's
 * "intent" string. Two regimes:
 *
 *  - Substantive user prompt (≥200 chars or contains punctuation/imperatives):
 *    drop the prior-assistant block entirely. The user has provided enough
 *    context on their own; carrying assistant text just enlarges the
 *    injection surface.
 *
 *  - Short user prompt ("yes", "do that", "option 2"): the assistant's
 *    prior turn is needed for the judge to resolve references. Truncate
 *    aggressively (last 500 chars — usually the question being asked)
 *    and run injection-pattern sanitisation.
 *
 * The output uses explicit, separable tags so the judge prompt can fence
 * trusted vs. untrusted content. See intent-judge.ts evaluate() — it
 * places this whole string inside <user_intent>…</user_intent>.
 */
const PRIOR_ASSISTANT_MAX_CHARS = 500;

export function buildContextualIntent(
  userPrompt: string,
  priorAssistant: string | null
): string {
  if (!priorAssistant) return userPrompt;

  // Substantive prompts don't need the prior context. Heuristic: long
  // (≥200 chars) or wordy (≥8 words). At that scale the user has
  // provided enough context that the prior assistant turn would only
  // enlarge the injection surface without changing the judge's verdict.
  const trimmed = userPrompt.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const isSubstantive = trimmed.length >= 200 || wordCount >= 8;
  if (isSubstantive) {
    return userPrompt;
  }

  const tail = priorAssistant.length > PRIOR_ASSISTANT_MAX_CHARS
    ? priorAssistant.substring(priorAssistant.length - PRIOR_ASSISTANT_MAX_CHARS)
    : priorAssistant;
  const sanitisedAssistant = sanitiseAssistantContent(tail);
  // User prompts only get fence-tag scrubbing, not the injection-pattern
  // sanitisation — users are allowed to type "ignore previous" if they
  // mean it. But they shouldn't be able to paste `</user_prompt>` and
  // break the fence either, even by accident.
  const sanitisedUser = sanitiseFenceTags(userPrompt);
  return `<prior_assistant_response>
${sanitisedAssistant}
</prior_assistant_response>

<user_prompt>
${sanitisedUser}
</user_prompt>`;
}

// =============================================================================
// Interactive/learn intent stack
// =============================================================================
//
// In interactive (and learn) mode, the user can submit a prompt while the
// agent is still working on the previous one. Claude Code combines queued
// prompts at the next generation boundary, so the judge has to authorise
// tool calls against ALL active goals — not just the most recent. The stack
// implements that.
//
// We classify each /intent into one of:
//   - confirmation       short ack ("yes", "ok", "option 2")
//   - queued / open      arrived during DRAINING (or OPEN) — append
//   - new-task           closed-state, low similarity to top of stack — clear resolved, push
//   - continuation       closed-state, high similarity — push, keep prior
//
// The hook calls applyIntentStackUpdate() which:
//   1. derives turnState from the timing markers,
//   2. classifies the prompt,
//   3. mutates the stack accordingly,
//   4. writes the stack back to the store and re-syncs the drift detector
//      via setActiveIntents().
//
// CONFIDENCE THRESHOLDS:
//   continuation_max_drift = 0.30   action embedding-similar enough to
//                                   the existing stack top — refinement
//   new_task_min_drift     = 0.50   topic switch — wipe resolved, push
// Everything in 0.30–0.50 (the "ambiguous middle") defaults to append
// without clearing resolved entries. This is the conservative choice — we
// keep the prior intent visible to the judge so a follow-up that turns
// out to BE the prior task isn't suddenly judged in isolation.

export const CONTINUATION_DRIFT_MAX = 0.30;
export const NEW_TASK_DRIFT_MIN = 0.50;

/**
 * Drift threshold for suspecting a sub-task. When the drift to the
 * top of the live stack is in the (CONTINUATION_DRIFT_MAX,
 * SUB_TASK_DRIFT_MAX] range AND structural cues fire (phrasing
 * pattern, parent-relation), classify as "sub-task" rather than
 * "continuation". Below this we treat as continuation; above this we
 * fall through to the topic-switch / replacement path.
 *
 * Empirically chosen at the midpoint between continuation (clearly
 * the same goal) and new-task (clearly different); step 4 telemetry
 * will tune.
 */
export const SUB_TASK_DRIFT_MAX = 0.40;

/**
 * Cosine *similarity* threshold used by the revisit classifier. When
 * a non-active historical entry's embedding has similarity >= this
 * value to the new prompt AND a phrasing pattern fires, classify as
 * revisit. Set high (0.65) because false-positive revisits are
 * expensive — we'd revive a stale goal and redirect the judge to it.
 *
 * Equivalent drift: 1 - 0.65 = 0.35. So the historical entry must be
 * meaningfully closer than the CONTINUATION_DRIFT_MAX boundary; not
 * just "vaguely similar topic", but "this looks like the same prior
 * goal I'm being asked to resume".
 */
export const REVISIT_SIMILARITY_MIN = 0.65;

/**
 * Phrasing patterns that strongly signal the user is returning to a
 * prior goal. The classifier requires BOTH a phrasing match AND a
 * historical-entry similarity above REVISIT_SIMILARITY_MIN before
 * classifying as revisit. Either signal alone is too weak: phrasing
 * without historical context could be a new task ("let's go back to
 * what we were saying — actually wait, do this instead"); high
 * similarity without phrasing might just be coincidental topic
 * overlap.
 *
 * Conservative starting set — step 4 telemetry will inform expansion.
 */
const REVISIT_PHRASING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgo\s+back\s+to\b/i,
  /\breturn\s+to\b/i,
  /\bback\s+to\s+(?:the|that|fixing|building|reviewing|working)\b/i,
  /\blet'?s\s+(?:resume|finish|continue\s+with)\b/i,
  /\bresume\s+(?:the|that|fixing|building)\b/i,
  /\bnow\s+back\s+to\b/i,
  /\bpick\s+up\s+(?:the|that|where)\b/i,
];

/**
 * Phrasing patterns that signal the new prompt SUPERSEDES an existing
 * active goal. "actually do X instead", "no wait, do Y" — the user is
 * replacing what they were just doing rather than continuing or
 * branching. Combined with mid-band drift to the top of the active
 * stack, these promote a "continuation" to a "replacement" and mark
 * the previous entry resolved.
 */
const REPLACEMENT_PHRASING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bactually\s+(?:do|make|build|fix|use|try)\b/i,
  /\binstead\s+of\b/i,
  /\b(?:no|wait|cancel)\s*[,.]?\s+(?:do|let'?s|fix|make)\b/i,
  /\bforget\s+(?:that|it)\b/i,
  /\bnever\s+mind\b/i,
  /\bscrap\s+(?:that|it)\b/i,
  /\b(?:do|make|fix)\s+\S+\s+instead\b/i,
];

/**
 * Phrasing patterns that signal a child task scoped under the active
 * goal. "first add tests", "before that, fix X", "on the way, let's
 * also Y". Combined with mid-band drift, these indicate sub-task
 * rather than continuation: parent stays live, child is added.
 */
const SUB_TASK_PHRASING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bfirst\s+(?:add|fix|build|let'?s|i'?ll|i\s+want|create)\b/i,
  /\bbefore\s+(?:that|we)\b/i,
  /\bon\s+the\s+way\b/i,
  /\bquick(?:ly)?\s+(?:add|fix|do|tweak)\b/i,
  /\bjust\s+(?:add|fix|do|tweak)\s+\S+\s+(?:then|first)\b/i,
  /\bsmall\s+(?:thing|tweak|fix|change)\s+(?:first|before)\b/i,
];

/** Match any of a pattern set against a prompt. */
function matchesAny(prompt: string, patterns: ReadonlyArray<RegExp>): boolean {
  for (const re of patterns) {
    if (re.test(prompt)) return true;
  }
  return false;
}

export type TurnState = "open" | "draining" | "closed";

export function deriveTurnState(prev: {
  prevUserPromptAt: number;
  prevPreToolUseAt: number;
  prevStopAt: number;
}): TurnState {
  // Stop is the boundary between turns. Anything earlier than the most
  // recent Stop is "from the previous turn" and doesn't influence state.
  const preToolSinceStop = prev.prevPreToolUseAt > prev.prevStopAt;
  const userPromptSinceStop = prev.prevUserPromptAt > prev.prevStopAt;

  if (!userPromptSinceStop && !preToolSinceStop) {
    // Fresh session OR previous turn fully completed (Stop fired). The
    // incoming prompt is the start of a new turn.
    return "closed";
  }
  if (preToolSinceStop) {
    // The agent has fired at least one PreToolUse since the last Stop —
    // it's mid-execution. The new prompt is queued.
    return "draining";
  }
  // User submitted a prompt since the last Stop, but no PreToolUse has
  // fired since — the LLM is generating but hasn't called a tool yet, OR
  // the user fired two prompts back-to-back before the LLM responded.
  // Either way, the new prompt is open-followup; the LLM will combine.
  return "open";
}

/**
 * Build an IntentEntry from a raw user prompt + optional prior assistant
 * context. Computes the embedding (one round-trip to the embedder) and
 * wraps the contextual form via buildContextualIntent.
 */
async function makeIntentEntry(
  prompt: string,
  priorAssistant: string | null,
  kind: IntentEntry["kind"],
  embeddingModel: string,
  images?: ImageBlock[],
): Promise<IntentEntry> {
  const embeddings = await embedAny(prompt, embeddingModel);
  return {
    // Synthesise stable id up-front. Step 1 of the history-active
    // migration relies on every entry having an id so the active set
    // can reference history by id.
    id: randomUUID(),
    prompt,
    contextual: buildContextualIntent(prompt, priorAssistant),
    embedding: embeddings[0],
    registeredAt: Date.now(),
    kind,
    resolved: false,
    images: images?.length ? images : undefined,
    // Default classifierSource for anything built here (original,
    // confirmation, plus the entries from applyIntentStackUpdate).
    // Step 4 will overwrite to "llm" / "llm-confirmed" when the async
    // classifier returns a verdict.
    classifierSource: "embedding",
  };
}

/**
 * Trim the stack:
 *   - drop resolved entries older than RESOLVED_INTENT_TTL_MS,
 *   - cap total length at MAX_INTENT_STACK by popping the OLDEST
 *     entry regardless of kind.
 *
 * Historical note: the original entry used to be sticky — preserved
 * across trims and re-prepended to the stack — on the rationale that
 * it was the "session-defining goal". In practice that turned the
 * very first prompt into a poison pill: long sessions where the user
 * had clearly moved on continued to anchor the judge on turn 1 ("review
 * the markdown plan") because trimStack kept reinserting it. Worse,
 * the new-task branch had already been updated (b60aee13) to evict
 * the original on a true topic switch — but trimStack contradicted
 * that by reanchoring it on the next overflow. The two were silently
 * fighting and trimStack was winning whenever new-task didn't fire
 * (i.e. when each prompt drifts incrementally from the previous, not
 * from the original — the common case in a working session).
 *
 * Drop the carve-out. The original is just an entry; if the user has
 * moved on enough that the stack overflows past the original's age,
 * it gets popped like anything else.
 *
 * @deprecated Step 2 of the history-active migration replaces
 *   trimStack with the cap+TTL logic baked into the SessionStore's
 *   activateIntent/markIntentResolved methods. Kept exported for
 *   any external callers that still depend on it; the production
 *   write path goes through trimActiveSet now.
 */
function trimStack(stack: IntentEntry[]): IntentEntry[] {
  const now = Date.now();
  const fresh = stack.filter(
    (e) => !e.resolved || now - e.registeredAt < RESOLVED_INTENT_TTL_MS,
  );
  if (fresh.length <= MAX_INTENT_STACK) return fresh;
  // Keep the most recent MAX_INTENT_STACK entries in registration order.
  return fresh.slice(-MAX_INTENT_STACK);
}

/**
 * Embedding-fallback classifier. Decides which `kind` to assign to
 * a fresh prompt without invoking an LLM, using only:
 *   - drift to the top of the live stack
 *   - similarity to non-active historical entries (revisit candidates)
 *   - phrasing patterns
 *   - turn state (open/draining/closed)
 *
 * Returns a verdict the caller applies via SessionStore methods.
 *
 * This is the synchronous fast path. Step 4 will spawn an async LLM
 * classifier in parallel; if the LLM disagrees with this verdict at
 * high confidence, it overrides on the next /evaluate. For now —
 * embedding is the source of truth.
 *
 * Inputs:
 *   prompt              — raw user prompt
 *   promptEmbedding     — pre-computed (caller already needs it for drift)
 *   active              — currently-active intents (from getActiveIntents)
 *   history             — full session history (active + resolved entries)
 *   driftToStackTop     — drift to last live entry, computed once by caller
 *   turnState           — open/draining/closed
 */
export interface EmbeddingClassifierVerdict {
  kind: IntentEntry["kind"];
  /** For "revisit" / "replacement" — id of the entry being acted on. */
  referencedEntryId?: string;
  /** What signal drove the decision; used for telemetry. */
  reason: string;
}

export function classifyIntentByEmbedding(
  prompt: string,
  promptEmbedding: number[],
  active: IntentEntry[],
  history: IntentEntry[],
  driftToStackTop: number | null,
  turnState: TurnState,
): EmbeddingClassifierVerdict {
  // Empty session — first prompt of the session, always original.
  if (active.length === 0 && history.length === 0) {
    return { kind: "original", reason: "empty session" };
  }

  // Turn-state preamble. These two states bind regardless of
  // similarity: the LLM is mid-generation (queued) or hasn't drawn a
  // turn boundary yet (open-followup). The user's prompt is going to
  // be combined with what's already in flight, not treated as a fresh
  // intent. Same as legacy.
  if (turnState === "draining") {
    return { kind: "queued", reason: "turn state draining" };
  }
  if (turnState === "open") {
    return { kind: "open-followup", reason: "turn state open" };
  }

  // Closed turn state — we get to make a real decision based on drift.

  // Revisit: phrasing pattern + a non-active historical entry strongly
  // resembles this prompt. Check before topic-switch — phrasing like
  // "go back to X" with high drift to current actives looks like a
  // topic switch but is actually a revival.
  if (matchesAny(prompt, REVISIT_PHRASING_PATTERNS)) {
    const activeIds = new Set(active.map((e) => e.id).filter(Boolean));
    let bestRevisit: { entry: IntentEntry; sim: number } | null = null;
    for (const e of history) {
      if (!e.id || activeIds.has(e.id)) continue; // not in active set
      if (!e.embedding || e.embedding.length === 0) continue;
      const sim = cosineSimilarity(e.embedding, promptEmbedding);
      if (sim >= REVISIT_SIMILARITY_MIN && (!bestRevisit || sim > bestRevisit.sim)) {
        bestRevisit = { entry: e, sim };
      }
    }
    if (bestRevisit) {
      return {
        kind: "revisit",
        referencedEntryId: bestRevisit.entry.id!,
        reason: `revisit phrasing + similarity ${bestRevisit.sim.toFixed(3)} >= ${REVISIT_SIMILARITY_MIN}`,
      };
    }
    // Phrasing matched but no historical anchor strong enough. Fall
    // through; the LLM (step 4) might still detect a revisit we missed.
  }

  // No drift signal at all — defaults to continuation. Same as legacy.
  if (driftToStackTop === null) {
    return { kind: "continuation", reason: "no drift signal — default continuation" };
  }

  // Topic switch: high drift, no replacement-phrasing override below.
  // The replacement check fires before this so "actually do Y instead"
  // (mid-to-high drift, replaces the active goal) doesn't mis-fire as
  // a topic switch that wipes the WHOLE stack.
  if (driftToStackTop > NEW_TASK_DRIFT_MIN) {
    return { kind: "new-task", reason: `drift ${driftToStackTop.toFixed(3)} > ${NEW_TASK_DRIFT_MIN}` };
  }

  // Replacement: phrasing match + the prompt is in the mid-band of
  // drift relative to the top active. We're not so far off that it's
  // a new task, not so close that it's a refinement — the user is
  // pivoting one specific goal. The replaced entry is the top of the
  // active stack (the freshest goal — what they were just doing).
  if (matchesAny(prompt, REPLACEMENT_PHRASING_PATTERNS) && active.length > 0) {
    const target = active[active.length - 1]; // most-recently registered active
    if (target.id) {
      return {
        kind: "replacement",
        referencedEntryId: target.id,
        reason: `replacement phrasing + drift ${driftToStackTop.toFixed(3)}`,
      };
    }
  }

  // Sub-task: phrasing match in the mid-band of drift. Parent (top of
  // active) stays live; the new entry is appended as a child.
  // Distinct from continuation in two ways:
  //   1. The judge sees both parent and child as live goals.
  //   2. When the child is later marked resolved (via Stop), the
  //      parent remains active — a continuation pop wouldn't preserve
  //      that hierarchy.
  if (
    matchesAny(prompt, SUB_TASK_PHRASING_PATTERNS) &&
    driftToStackTop <= SUB_TASK_DRIFT_MAX &&
    active.length > 0
  ) {
    const parent = active[active.length - 1];
    return {
      kind: "sub-task",
      referencedEntryId: parent.id,
      reason: `sub-task phrasing + drift ${driftToStackTop.toFixed(3)} <= ${SUB_TASK_DRIFT_MAX}`,
    };
  }

  // Continuation: low drift, no special phrasing.
  if (driftToStackTop < CONTINUATION_DRIFT_MAX) {
    return { kind: "continuation", reason: `drift ${driftToStackTop.toFixed(3)} < ${CONTINUATION_DRIFT_MAX}` };
  }

  // Ambiguous middle — default to continuation, conservative. Step 4's
  // LLM classifier is most useful here, where embeddings aren't
  // distinguishing.
  return {
    kind: "continuation",
    reason: `ambiguous drift ${driftToStackTop.toFixed(3)} — default continuation`,
  };
}

/**
 * History-active equivalent of trimStack. Operates on the resolved
 * active set (entries already materialised from history+activeIntentIds)
 * and decides which to keep:
 *
 *   1. Drop resolved entries whose registeredAt is older than
 *      RESOLVED_INTENT_TTL_MS. They stay in history (the SessionStore
 *      enforces history-side TTL separately at 30d) but are no longer
 *      live for the judge.
 *   2. Cap the live set at MAX_ACTIVE_INTENTS via LRU on lastActiveAt
 *      (fallback registeredAt). Newest stay; oldest get evicted to
 *      resolved.
 *
 * Returns an evictionPlan: which ids should be marked resolved
 * (removed from active, kept in history). The caller applies it via
 * the SessionStore's markIntentResolved.
 */
function planActiveSetEviction(active: IntentEntry[]): {
  keep: IntentEntry[];
  resolveIds: string[];
} {
  const now = Date.now();
  const resolveIds: string[] = [];
  const fresh = active.filter((e) => {
    if (!e.resolved) return true;
    if (now - e.registeredAt < RESOLVED_INTENT_TTL_MS) return true;
    if (e.id) resolveIds.push(e.id);
    return false;
  });
  if (fresh.length <= MAX_ACTIVE_INTENTS) {
    return { keep: fresh, resolveIds };
  }
  // LRU: sort oldest-touch-first, evict from the front.
  const sorted = [...fresh].sort((a, b) => {
    const ta = a.lastActiveAt ?? a.registeredAt;
    const tb = b.lastActiveAt ?? b.registeredAt;
    return ta - tb;
  });
  const evictCount = sorted.length - MAX_ACTIVE_INTENTS;
  const evicted = sorted.slice(0, evictCount);
  const keepIds = new Set(sorted.slice(evictCount).map((e) => e.id));
  for (const e of evicted) {
    if (e.id) resolveIds.push(e.id);
  }
  // Restore registration order for the kept entries.
  const keep = active.filter((e) => e.id && keepIds.has(e.id));
  return { keep, resolveIds };
}

export interface IntentStackUpdateResult {
  /** What classification we applied. */
  kind: IntentEntry["kind"];
  /** Turn state at the moment of the new prompt. */
  turnState: TurnState;
  /** Final stack after the update. */
  stack: IntentEntry[];
  /**
   * Cosine distance to the closest stack entry before the new prompt
   * was added — null when the stack was empty (very first prompt).
   */
  driftToStackTop: number | null;
  /**
   * ID of the freshly-registered entry. Step 4 uses this to apply
   * an async-LLM-classifier override: if the LLM disagrees with the
   * embedding fallback at high confidence, the override needs to
   * mutate this specific entry (overwrite its kind, possibly
   * mark/activate other entries) before the next /evaluate.
   */
  newEntryId?: string;
}

/**
 * Apply the interactive/learn stack update for a new UserPromptSubmit.
 *
 * @param store              the SessionStore (cached or in-memory)
 * @param sessionId
 * @param prompt             raw user prompt (after fence-tag scrub)
 * @param priorAssistant     prior assistant text from transcript (may be null)
 * @param isConfirmation     classification from the /intent regex
 * @param prevTimings        markers BEFORE we noted this UserPromptSubmit
 * @param embeddingModel     CONFIG.embeddingModel
 * @param images             attached images, if any
 */
export async function applyIntentStackUpdate(
  store: SessionStore,
  sessionId: string,
  prompt: string,
  priorAssistant: string | null,
  isConfirmation: boolean,
  prevTimings: {
    prevUserPromptAt: number;
    prevPreToolUseAt: number;
    prevStopAt: number;
  },
  embeddingModel: string,
  images?: ImageBlock[],
): Promise<IntentStackUpdateResult> {
  const turnState = deriveTurnState(prevTimings);
  const existing = await store.getActiveIntents(sessionId);

  // First prompt of the session — always "original".
  if (existing.length === 0) {
    const entry = await makeIntentEntry(
      prompt,
      priorAssistant,
      "original",
      embeddingModel,
      images,
    );
    const stack = [entry];
    // setActiveIntents writes both legacy activeIntents and the new
    // history+ids fields. Step 7 cleanup will switch this to a pure
    // appendToHistory + activateIntent call once setActiveIntents is
    // removed.
    await store.setActiveIntents(sessionId, stack);
    return { kind: "original", turnState, stack, driftToStackTop: null, newEntryId: entry.id };
  }

  // Confirmation: adopt the prior assistant proposal as the new top.
  // Falls through to "queued" if there is no prior assistant context —
  // a bare "yes" with no proposal can't carry a meaningful goal so we
  // treat it as a queued/open follow-up against the existing stack.
  if (isConfirmation && priorAssistant) {
    const entry = await makeIntentEntry(
      prompt,
      priorAssistant,
      "confirmation",
      embeddingModel,
      images,
    );
    const planned = planActiveSetEviction([...existing, entry]);
    if (planned.resolveIds.length > 0) {
      await store.markIntentResolved(sessionId, planned.resolveIds);
    }
    await store.setActiveIntents(sessionId, planned.keep);
    return {
      kind: "confirmation",
      turnState,
      stack: planned.keep,
      driftToStackTop: 0,
      newEntryId: entry.id,
    };
  }

  // Compute drift to the most recent live stack entry — the variable
  // name has always been driftToStackTop, but the implementation took
  // max-over-entire-stack similarity, which monotonically converges to
  // 1 (drift -> 0) as the stack grows. In long sessions every new
  // CS-development prompt was similar to *something* in a 5+ entry
  // stack, so new-task could never fire. Switch to genuine
  // top-of-live-stack: only compare against the latest non-resolved
  // entry. If nothing is live, fall back to the most recent existing
  // entry so we keep some signal.
  const promptEmbedding = (await embedAny(prompt, embeddingModel))[0];
  const liveEntries = existing.filter((e) => !e.resolved);
  const compareSet = liveEntries.length > 0 ? liveEntries : existing;
  // Top of stack = most recently registered entry. compareSet is in
  // registration order, so the last element is the freshest.
  let topSim: number | null = null;
  for (let i = compareSet.length - 1; i >= 0; i--) {
    const e = compareSet[i];
    if (e.embedding && e.embedding.length > 0) {
      topSim = cosineSimilarity(e.embedding, promptEmbedding);
      break;
    }
  }
  const driftToStackTop = topSim === null ? null : 1 - topSim;

  // Embedding-fallback classifier — synchronous decision based on
  // drift, history, and phrasing. Step 4 will spawn an async LLM
  // classifier in parallel; if it disagrees at high confidence the
  // active set is updated on the next /evaluate.
  const history = await store.getIntentHistory(sessionId);
  const verdict = classifyIntentByEmbedding(
    prompt,
    promptEmbedding,
    existing,
    history,
    driftToStackTop,
    turnState,
  );
  const kind = verdict.kind;

  // Per-kind state transitions on the active set.
  let baseStack = [...existing];

  if (kind === "new-task") {
    // True topic switch — wipe resolved entries (including the
    // original) so the judge isn't anchored on a defunct goal.
    const toResolve = baseStack.filter((e) => e.resolved && e.id).map((e) => e.id!);
    if (toResolve.length > 0) {
      await store.markIntentResolved(sessionId, toResolve);
    }
    baseStack = baseStack.filter((e) => !e.resolved);
  } else if (kind === "replacement" && verdict.referencedEntryId) {
    // Mark only the replaced entry resolved (kept in history). Other
    // active goals stay live — the user is replacing one specific
    // goal, not switching topics entirely.
    await store.markIntentResolved(sessionId, [verdict.referencedEntryId]);
    baseStack = baseStack.filter((e) => e.id !== verdict.referencedEntryId);
  } else if (kind === "revisit" && verdict.referencedEntryId) {
    // Bring the historical entry back into the active set. The
    // SessionStore's activateIntent handles LRU eviction if the
    // active set is already at capacity. Other active entries stay
    // live in case the user is multi-tasking, but the new prompt
    // anchors on the revived goal.
    await store.activateIntent(sessionId, verdict.referencedEntryId);
    // Re-read the active set so the freshly-revived entry is included.
    baseStack = await store.getActiveIntents(sessionId);
  }
  // continuation, sub-task, queued, open-followup: no eviction, just
  // append the new entry. Sub-task is identical to continuation from
  // an active-set perspective; the difference is the kind tag, which
  // step 5 renders to the judge so it can distinguish parent/child.

  const entry: IntentEntry = {
    // Synthesise the id up-front so planActiveSetEviction can refer
    // to this entry by id (it's the freshest entry, never a candidate
    // for eviction in a fresh-stack pass, but we want symmetry with
    // the rest of the entries — every active intent should have an
    // id once it leaves this function).
    id: randomUUID(),
    prompt,
    contextual: buildContextualIntent(prompt, priorAssistant),
    embedding: promptEmbedding,
    registeredAt: Date.now(),
    kind,
    resolved: false,
    images: images?.length ? images : undefined,
    // classifierSource is "embedding" until step 4 wires the async
    // LLM classifier; entries from the embedding-only path are tagged
    // explicitly so the dashboard + telemetry can count overrides.
    classifierSource: "embedding",
    // referencedEntryId carried through for replacement/revisit/
    // sub-task entries so the dashboard and step 5's judge prompt
    // can render parent/child relationships.
    referencedEntryId: verdict.referencedEntryId,
  };
  // LRU-evict to MAX_ACTIVE_INTENTS, marking evicted ids resolved (kept
  // in history). Replaces the old trimStack call.
  const planned = planActiveSetEviction([...baseStack, entry]);
  if (planned.resolveIds.length > 0) {
    await store.markIntentResolved(sessionId, planned.resolveIds);
  }
  await store.setActiveIntents(sessionId, planned.keep);

  console.log(
    `  [SESSION ${sessionId.substring(0, 8)}] [INTENT-CLASSIFY] kind=${kind}` +
    (verdict.referencedEntryId ? ` ref=${verdict.referencedEntryId.substring(0, 8)}` : "") +
    ` drift=${driftToStackTop?.toFixed(3) ?? "n/a"} (${verdict.reason})`,
  );

  return { kind, turnState, stack: planned.keep, driftToStackTop, newEntryId: entry.id };
}

/**
 * Apply an async-LLM-classifier override against a session whose
 * embedding-fallback verdict is already in place. Called after
 * /intent has returned its response — the LLM call (1.5–2.5s) runs
 * in the background and this function takes the verdict, decides
 * whether to override the embedding-fallback decision, and applies
 * the change via SessionStore methods.
 *
 * Override policy:
 *   - LLM verdict same kind as embedding fallback → no-op, just tag
 *     the entry's classifierSource as "llm-confirmed" for telemetry.
 *   - LLM verdict different AND confidence is "high" → apply override.
 *   - LLM verdict different AND confidence is "medium" or "low" →
 *     keep embedding fallback. Low-confidence flips would just churn
 *     state without clear benefit; logged for telemetry.
 *
 * Per the design doc, the override mutates the active set (mark
 * entries resolved, activate historical entries) but DOES NOT
 * retroactively change the kind of an entry that's already been
 * registered — the new entry's kind is updated in place, but
 * historical entries keep whatever kind they had at registration.
 */
export async function applyClassifierOverride(
  store: SessionStore,
  sessionId: string,
  newEntryId: string,
  embeddingKind: IntentEntry["kind"],
  llmVerdict: import("./intent-classifier.js").ClassifierVerdict,
): Promise<{ overridden: boolean; reason: string }> {
  // Same kind — confirm and tag for telemetry.
  if (llmVerdict.kind === embeddingKind) {
    await tagClassifierConfirmed(store, sessionId, newEntryId);
    return { overridden: false, reason: "llm agreed with embedding" };
  }
  // Different kind but low confidence — defer to embedding.
  if (llmVerdict.confidence !== "high") {
    return {
      overridden: false,
      reason: `llm disagreed (${embeddingKind} → ${llmVerdict.kind}) but confidence ${llmVerdict.confidence} — keeping embedding`,
    };
  }
  // Apply the override. The new entry has already been registered
  // with embeddingKind; update its kind + classifierSource in place,
  // and apply per-kind state transitions on the active set.
  const history = await store.getIntentHistory(sessionId);
  const newEntry = history.find((e) => e.id === newEntryId);
  if (!newEntry) {
    return {
      overridden: false,
      reason: `llm verdict ${llmVerdict.kind} arrived but entry ${newEntryId} no longer in history`,
    };
  }
  // Roll back any state changes made by the embedding kind, then
  // apply the LLM's decision. Concretely: if embedding said
  // "replacement" we previously marked an entry resolved — re-activate
  // it, then apply the LLM's verdict cleanly.
  //
  // For v1 we keep this simple: only state transitions for the LLM
  // kind are applied. Roll-back of embedding-fallback state changes
  // is left to step 5+ if the override-disagreement rate justifies
  // the complexity. Most disagreements will be in the
  // continuation/sub-task/replacement family where the active set
  // is already close to right.
  if (llmVerdict.kind === "revisit" && llmVerdict.referencedEntryId) {
    await store.activateIntent(sessionId, llmVerdict.referencedEntryId);
  } else if (llmVerdict.kind === "replacement" && llmVerdict.referencedEntryId) {
    await store.markIntentResolved(sessionId, [llmVerdict.referencedEntryId]);
  } else if (llmVerdict.kind === "new-task") {
    // Mark all other actives resolved.
    const active = await store.getActiveIntents(sessionId);
    const toResolve = active
      .filter((e) => e.id && e.id !== newEntryId)
      .map((e) => e.id!);
    if (toResolve.length > 0) {
      await store.markIntentResolved(sessionId, toResolve);
    }
  }
  // Update the new entry's kind + classifierSource + referencedEntryId
  // in history. We rebuild the active set view by re-applying
  // setActiveIntents with the updated entry mixed back in.
  const updatedHistory = history.map((e) =>
    e.id === newEntryId
      ? {
          ...e,
          kind: llmVerdict.kind as IntentEntry["kind"],
          classifierSource: "llm" as const,
          referencedEntryId: llmVerdict.referencedEntryId,
        }
      : e,
  );
  // Rebuild active using whatever the store now holds, mixing in the
  // updated entry by id.
  const currentActive = await store.getActiveIntents(sessionId);
  const updatedActive = currentActive.map((e) =>
    e.id === newEntryId
      ? updatedHistory.find((h) => h.id === newEntryId)!
      : e,
  );
  await store.setActiveIntents(sessionId, updatedActive);

  return {
    overridden: true,
    reason: `llm overrode embedding ${embeddingKind} → ${llmVerdict.kind} (high conf)`,
  };
}

/**
 * Tag an existing history entry's classifierSource as "llm-confirmed"
 * — the LLM agreed with the embedding fallback. Doesn't change the
 * active set; this is purely a telemetry marker on the entry.
 */
async function tagClassifierConfirmed(
  store: SessionStore,
  sessionId: string,
  entryId: string,
): Promise<void> {
  // The SessionStore doesn't have a generic "update one entry" method
  // because every other call site updates the whole active set. We
  // re-emit the active set with the entry's classifierSource updated
  // — same data, same shape, just the tag flipped. Cheap on the
  // happy path (LLM agrees most of the time) and avoids inflating
  // the SessionStore interface for a single field update.
  const active = await store.getActiveIntents(sessionId);
  const next = active.map((e) =>
    e.id === entryId ? { ...e, classifierSource: "llm-confirmed" as const } : e,
  );
  // Only write if something actually changed (the entry was active).
  if (next.some((e) => e.id === entryId)) {
    await store.setActiveIntents(sessionId, next);
  }
}

export async function backfillFromTranscript(
  sessionId: string,
  transcriptPathOrContent: string,
  isContent = false
): Promise<void> {
  let raw: string;
  if (isContent) {
    raw = transcriptPathOrContent;
  } else {
    const safe = safeServerReadablePath(transcriptPathOrContent);
    if (!safe) return;
    try {
      raw = readFileSync(safe, "utf8");
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

        if (msg.type === "user") {
          const { text, images: imgs } = extractTextAndImages(msg.message?.content);
          const trimmed = text.trim();
          if (!isSyntheticUserEntry(msg, trimmed) && (trimmed || imgs.length)) {
            userPrompts.push({ text: trimmed, images: imgs });
          }
        }

        if (msg.type === "assistant") {
          const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const block of blocks) {
            if (block.type === "tool_use") {
              const tool = block.name;
              const input = block.input ?? {};
              toolCalls.push({ tool, input });

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
      } catch {}
    }

    if (userPrompts.length === 0) return;

    const { lastUser, priorAssistant, images: lastImages } =
      extractLastUserAndPriorAssistant(raw, true);
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

    for (let i = 0; i < goalIdx; i++) {
      const p = userPrompts[i];
      await tracker.registerIntent(sessionId, p.text, true, p.images);
    }
    await tracker.registerIntent(sessionId, goalPrompt, false, goalImages);
    await interceptor.registerGoal(sessionId, contextualGoal, goalImages);
    registeredSessions.add(sessionId);

    for (const path of filesRead) {
      await tracker.recordFileRead(sessionId, path, "(backfilled)");
    }
    for (const file of filesWritten) {
      await tracker.recordFileWrite(sessionId, file.path, file.content, file.isEdit);
    }

    for (const tc of toolCalls) {
      await tracker.recordToolCall(sessionId, tc.tool, tc.input, "allow", null);
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
    interceptorLog: interceptor.getLog(sessionId).map((r) => ({
      tool: r.tool,
      input: r.input,
      stage: r.stage,
      allowed: r.allowed,
      similarity: r.similarity,
      reason: r.reason,
      evaluationMs: r.evaluationMs,
    })),
  };
}
