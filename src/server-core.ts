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
import type { SessionStore, ImageBlock } from "./session-store.js";
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
  const ctx = await tracker.getSessionContext(sessionId);
  if (!ctx.originalTask && ctx.currentTurn === 0 && ctx.turnIntents.length === 0) {
    return null;
  }
  const summary = await tracker.getFullSessionSummary(sessionId);
  const driftHistory = tracker.getDriftDetector(sessionId).getHistory();
  return {
    sessionId,
    timestamp: new Date().toISOString(),
    originalTask: ctx.originalTask,
    summary,
    hijackStrikes: await tracker.getHijackStrikes(sessionId),
    lockedHijacked: await tracker.isLocked(sessionId),
    toolHistory: ctx.recentTools,
    // Goal history — every user prompt that registered an intent. Includes
    // the original (turnNumber 0) and every subsequent turn. Embeddings are
    // stripped because they're large and only useful server-side.
    turnIntents: ctx.turnIntents.map((t) => ({
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
