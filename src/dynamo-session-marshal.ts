/**
 * Marshalling helpers + per-item size budgets for `DynamoSessionStore`.
 *
 * Pure utilities — no DynamoDB client, no class instance state.
 * Extracted from `dynamo-session-store.ts` so the store class itself
 * stays focused on orchestration and the size caps + key builders are
 * reusable from anywhere that touches the same schema.
 *
 * Schema constants:
 *   - TTL_DAYS / TTL_SECONDS — row-level expiry (30d)
 *   - GSI_NAME / GSI_PK      — global secondary index for "list all sessions"
 *
 * Field caps protect the 400KB-per-item DynamoDB hard limit. Values are
 * truncated silently — the judge has already seen the full content via
 * the request body; persistence is for the dashboard and forensics.
 */

import { createHash } from "node:crypto";
import type { IntentEntry } from "./session-types.js";

// ---- constants --------------------------------------------------------------

export const TTL_DAYS = 30;
export const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;
export const GSI_NAME = "gsi1";
export const GSI_PK = "SESSION";

// Per-field size caps. DynamoDB enforces a 400KB hard limit per item; we
// cap well under that so a single huge attribute (e.g. a pasted file
// dump in a user prompt) can't break writes. Values are truncated silently
// — the judge has already seen the full content via the request body.
export const MAX_PROMPT_BYTES = 100_000;    // user prompt text
export const MAX_TOOL_INPUT_BYTES = 50_000; // serialised tool_input
export const MAX_FILE_CONTENT_BYTES = 10_000; // already truncated in sanitisers; belt-and-braces

/**
 * Window for coalescing touchActiveIntent calls. Every /evaluate
 * touches every active intent (3-5 per turn × tens of tool calls per
 * turn) — without coalescing this would mean ~150 Dynamo writes per
 * turn just for LRU bookkeeping. 500ms is short enough to keep LRU
 * ordering fresh against legitimate session lifetimes (a session
 * paused 500ms+ between tool calls already loses its hot-path
 * advantage) and long enough to fold an entire turn's touches into
 * one write.
 */
export const TOUCH_FLUSH_MS = 500;

export const INTENT_SK_PREFIX = "INTENT#";

/** Per-IntentEntry persisted size budget. The serialised row carries
 *  prompt + contextual + a 1024-d Cohere embedding (~10KB) + a few
 *  small fields, comfortably under DynamoDB's 400KB hard limit. */
export const MAX_INTENT_ENTRY_FIELD_BYTES = 10_000;

// ---- helpers ----------------------------------------------------------------

/**
 * Synthesise a deterministic id for a legacy IntentEntry that
 * predated the history-active schema. The id is a function of the
 * prompt + registeredAt + position so the same entry always produces
 * the same id across reads — referencedEntryId pointers from the
 * classifier remain stable through container restarts.
 */
export function deterministicLegacyId(entry: IntentEntry, position: number): string {
  const key = `${entry.registeredAt}|${position}|${entry.prompt.substring(0, 200)}`;
  const hex = createHash("sha256").update(key).digest("hex");
  // UUID v4-shaped formatting so downstream code that parses the id
  // doesn't choke on a raw hex string.
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32),
  ].join("-");
}

export function truncString(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.substring(0, limit);
}

export function truncToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(input);
  if (json.length <= MAX_TOOL_INPUT_BYTES) return input;
  // Overrun: keep the shape but replace each string value with a truncated
  // copy. Shape preservation matters for the judge and the dashboard.
  const clipped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    clipped[k] = typeof v === "string"
      ? truncString(v, Math.floor(MAX_TOOL_INPUT_BYTES / Math.max(1, Object.keys(input).length)))
      : v;
  }
  return clipped;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function ttl(): number {
  return now() + TTL_SECONDS;
}

export function pad(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

export function pk(sessionId: string): string {
  return `SESSION#${sessionId}`;
}

export function hashPath(path: string): string {
  return createHash("sha1").update(path).digest("hex").substring(0, 16);
}

/**
 * Build an IntentEntry from a DynamoDB Item retrieved via Get/Query
 * on an INTENT# row. Strips the dynamo-specific (pk/sk/ttl) fields
 * and coerces optional ones to their TS-typed defaults.
 */
export function rowToIntentEntry(item: Record<string, any>): IntentEntry {
  return {
    id: item.id,
    prompt: item.prompt ?? "",
    contextual: item.contextual ?? "",
    embedding: item.embedding ?? [],
    registeredAt: item.registeredAt,
    lastActiveAt: item.lastActiveAt,
    classifierSource: item.classifierSource,
    referencedEntryId: item.referencedEntryId,
    kind: item.kind,
    resolved: item.resolved ?? false,
    images: item.images,
  };
}

/**
 * Sort key for an IntentEntry row. The registeredAt prefix makes a
 * `begins_with(sk,"INTENT#")` query return entries in chronological
 * order, which is what every reader of intentHistory expects. The id
 * suffix disambiguates same-millisecond inserts (rare, but possible
 * when a confirmation prompt and its parent share a timestamp).
 *
 * 13-digit zero-pad fits epoch-ms through year 2286.
 */
export function intentSk(registeredAt: number, id: string): string {
  return `INTENT#${String(registeredAt).padStart(13, "0")}#${id}`;
}
