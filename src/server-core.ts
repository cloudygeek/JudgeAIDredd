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
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { inspect } from "node:util";
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

// File logger — mirrors all console output to dredd-YYYY-MM-DD.log
const LOG_DIR = values["console-log-dir"]!;
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
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
  keyType: "user" | "service" | "benchmark" | null;
  keyPresented: boolean;
  keyValid: boolean;
}

const ANON: RequestIdentity = { ownerSub: null, keyType: null, keyPresented: false, keyValid: false };

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
    return { ownerSub: null, keyType: null, keyPresented: true, keyValid: false };
  }

  return {
    ownerSub: validated.ownerSub,
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
 * sanitiseAssistantContent below.
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
 * Strip obvious instruction-injection patterns from untrusted assistant
 * text. Preserves length-ish by replacing with `[REDACTED:reason]`. Does
 * NOT attempt full sanitisation — the system-prompt directive carries
 * the bulk of the defence; this is belt-and-braces for the obvious
 * vectors.
 */
function sanitiseAssistantContent(text: string): string {
  let out = text;
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
  const sanitised = sanitiseAssistantContent(tail);
  return `<prior_assistant_response>
${sanitised}
</prior_assistant_response>

<user_prompt>
${userPrompt}
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
