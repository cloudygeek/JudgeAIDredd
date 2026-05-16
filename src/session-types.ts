/**
 * Per-session data model.
 *
 * The shapes here are shared between InMemorySessionStore
 * (`session-tracker.ts`) and DynamoSessionStore (`dynamo-session-store.ts`),
 * plus consumers like the dashboard, interceptor, and judge.
 *
 * Extracted from `session-tracker.ts` so consumers can import types
 * without pulling in the store implementation. Both the in-memory
 * store and `session-store.ts` re-export these for backwards
 * compatibility — existing
 *   import type { SessionState } from "./session-tracker.js";
 * keeps working.
 */

import type { DriftDetector } from "./drift-detector.js";
import type { ClaudeMdScanResult } from "./claudemd-scanner.js";

export interface ImageBlock {
  /** Base64-encoded image data */
  data: string;
  /** MIME type, e.g. "image/png", "image/jpeg", "image/webp", "image/gif" */
  mediaType: string;
}

export interface TurnIntent {
  turnNumber: number;
  timestamp: string;
  prompt: string;
  embedding: number[];
  /** Images attached to this prompt (from pasted screenshots etc.) */
  images?: ImageBlock[];
  /**
   * In interactive/learn mode, the rolling currentGoal updates on every
   * non-confirmation user prompt — short replies like "yes" / "ok" /
   * "option 2" / "FINISHED" are treated as confirming the previous turn
   * rather than as new goals. This flag records the classification at the
   * time `/intent` ran so the dashboard can render confirmation noise
   * distinctly from real goal pivots without re-running the regex.
   *
   * Optional because (a) older session records don't have it and (b) the
   * autonomous mode path doesn't compute it (every prompt is a fresh
   * intent there).
   */
  isConfirmation?: boolean;
}

/**
 * An entry on the interactive/learn intent stack. The LLM combines
 * queued user prompts when it begins generating, so the judge needs to
 * track ALL active goals, not just the latest one. A tool call is
 * on-task if it advances ANY active intent.
 *
 * Stack semantics, set by the kind:
 *   - "original"      first prompt of the session
 *   - "confirmation"  short ack like "yes"/"ok"; carries the prior
 *                     assistant proposal as the contextual goal
 *   - "queued"        user typed while a tool call was in flight
 *                     (DRAINING). LLM will combine with current
 *                     generation; we always append, never replace
 *   - "open-followup" user typed a second prompt before LLM picked
 *                     anything up (OPEN). Same treatment as queued
 *   - "continuation"  closed-state prompt that's similar (drift<0.3)
 *                     to the top of stack — refinement / next step
 *   - "new-task"      closed-state prompt that's distant (drift>0.5)
 *                     — clears resolved entries first, then pushes
 *
 * `resolved` is set true when Stop fires; on the next "new-task" push
 * we evict everything resolved.
 */
export interface IntentEntry {
  /** Stable ID. Used by intentHistory + activeIntentIds in the
   *  history-active model so an entry can be referenced from outside
   *  its array position. Optional for backwards compatibility — the
   *  legacy single-stack model didn't have ids. Step 1 of the
   *  history-active migration generates synthesised ids on read for
   *  legacy entries; new entries always get a UUID. */
  id?: string;
  /** Plain user prompt as it arrived (after fence-tag scrub). */
  prompt: string;
  /** Wrapped form passed to judge (may include prior_assistant_response). */
  contextual: string;
  /** Embedding of the plain prompt — used by drift detector min-over-stack. */
  embedding: number[];
  /** Epoch ms when this entry was pushed. */
  registeredAt: number;
  /** Epoch ms when this entry was last materialised into the active
   *  set for /evaluate. Updated on every /evaluate that includes this
   *  entry. Drives LRU eviction of the active set in the history-active
   *  model. Optional for backwards compatibility — defaults to
   *  registeredAt for legacy entries. */
  lastActiveAt?: number;
  /** Which classifier produced the kind. "embedding" = synchronous
   *  embedding-fallback; "llm" = async LLM classifier overruled the
   *  embedding; "llm-confirmed" = LLM agreed with embedding;
   *  "embedding-fallback-timeout" = LLM never returned within the soft
   *  cap. Optional for backwards compatibility — undefined for legacy
   *  entries, treated as "embedding". */
  classifierSource?: "embedding" | "llm" | "llm-confirmed" | "embedding-fallback-timeout";
  /** ID of an existing entry this one references. Set when kind is
   *  "revisit" (the historical entry being resumed) or "replacement"
   *  (the entry being superseded). Used by the active-set update
   *  logic to know which existing entry to revive or mark resolved. */
  referencedEntryId?: string;
  kind:
    | "original"
    | "confirmation"
    | "queued"
    | "open-followup"
    | "continuation"
    | "new-task"
    /** Step-3 additions: child of an active goal (parent stays live). */
    | "sub-task"
    /** Step-3 additions: supersedes referencedEntryId (mark it resolved). */
    | "replacement"
    /** Step-3 additions: user returned to a historical entry; revive it. */
    | "revisit";
  /** Set true on Stop. Resolved entries are evicted on the next new-task push. */
  resolved: boolean;
  /** Images attached to the originating prompt, if any. */
  images?: ImageBlock[];
}

export interface ToolCallRecord {
  turnNumber: number;
  tool: string;
  input: Record<string, unknown>;
  decision: "allow" | "deny" | "review";
  similarity: number | null;
  /** ISO timestamp when the decision was recorded. Optional for
   *  backwards compatibility — pre-2026-05-13 records didn't carry it,
   *  and the dashboard renders "-" when absent. */
  timestamp?: string;
  /** Claude Code's per-call identifier (toolu_*). Same value comes
   *  back in PostToolUse, which is how we (or the dashboard) can
   *  pair a Pre-decision with its Post-execution outcome.
   *  Optional: benchmark harnesses don't emit one. */
  toolUseId?: string | null;
  /** Pipeline stage that made the decision. Persisted from
   *  InterceptionResult.stage. Optional for backwards compat — pre-
   *  2026-05-16 records will see undefined. */
  stage?: string;
  /** Human-readable reason from InterceptionResult. Drives the
   *  "Reason" line on the dashboard's tool-detail popup. */
  reason?: string;
  /** Judge verdict + reasoning when the call went through the LLM
   *  judge. Null/undefined for stages that short-circuited earlier
   *  (policy-allow, drift-allow, user-deny, pattern-trust-allow). */
  judgeVerdict?: {
    verdict: "consistent" | "drifting" | "hijacked";
    reasoning: string;
    /** Numeric 0..1 — matches JudgeVerdict.confidence shape. */
    confidence: number;
    durationMs: number;
    inputTokens?: number;
  } | null;
  /** Phase 4 — which of the user's permission rules matched. */
  userPermissionMatch?: { kind: "allow" | "deny"; rule: string };
  /** Phase 8 — pattern-trust signal. */
  patternTrust?: { hard: boolean; matched: number; topSim: number; topSummary: string };
}

export interface FileRecord {
  /** File path */
  path: string;
  /** How many times this file has been written/edited this session */
  writeCount: number;
  /** Current content (accumulated from Write/Edit operations) */
  content: string;
  /** Which turns modified this file */
  modifiedAtTurns: number[];
  /** Whether this file was also read earlier in the session */
  wasReadFirst: boolean;
  /** Whether content contains known canary/sensitive patterns */
  containsCanary: boolean;
}

export interface FileReadRecord {
  /** File path that was read */
  path: string;
  /** Turn when it was read */
  turn: number;
  /** Content that was read (truncated) */
  content: string;
  /** Whether this was a sensitive file */
  isSensitive: boolean;
}

export interface EnvVarRecord {
  /** Variable name */
  name: string;
  /** Value (may be redacted for sensitive vars) */
  value: string;
  /** Turn when it was set/modified */
  turn: number;
  /** How it was set (export, .env write, bashrc, etc.) */
  source: string;
  /** Whether this looks sensitive */
  isSensitive: boolean;
}

/**
 * Snapshot of the user's Claude Code .permissions.{allow,deny,ask}
 * lists, copied into the session at /intent time from the
 * `jaid-user-permissions` table (or directly from the hook's full
 * upload). /evaluate reads from this in-session copy on the hot path
 * so it never has to touch the cross-session table.
 *
 * Null when the hook never uploaded any permissions (either it's an
 * old hook version pre-Phase-1, or the user has no .permissions
 * configured anywhere).
 */
export interface UserPermissionsLists {
  /** sha256 of the canonical merged payload — matches the hook's hash. */
  hash: string;
  allow: string[];
  deny: string[];
  ask: string[];
  /** ISO-8601 of when these lists were last copied into session META. */
  copiedAt: string;
}

export interface TurnMetrics {
  turnNumber: number;
  timestamp: string;
  /** Drift from original task (0 = aligned, 1 = completely diverged) */
  driftFromOriginal: number | null;
  /** Drift from previous turn */
  driftFromPrevious: number | null;
  /** Current threshold classification */
  classification: "on-task" | "scope-creep" | "drifting" | "hijacked";
  /** Tool calls this turn */
  toolCallCount: number;
  /** Tool calls denied this turn */
  toolCallsDenied: number;
  /** Whether a goal reminder was injected */
  goalReminderInjected: boolean;
  /** Whether the turn was blocked */
  blocked: boolean;
}

export interface SessionState {
  sessionId: string;
  /** The first prompt — the original task */
  originalIntent: TurnIntent | null;
  /** All subsequent prompts — turn-by-turn intent history */
  turnIntents: TurnIntent[];
  /** All tool calls evaluated */
  toolHistory: ToolCallRecord[];
  /** Current turn number */
  currentTurn: number;
  /** Drift detector instance for this session */
  driftDetector: DriftDetector;
  /** Embedding of the original task */
  originalEmbedding: number[] | null;
  /** Files written/edited during this session (keyed by path) */
  filesWritten: Map<string, FileRecord>;
  /** Files read during this session */
  filesRead: FileReadRecord[];
  /** Environment variables set/modified during this session */
  envVars: Map<string, EnvVarRecord>;
  /** Per-turn metrics for logging and analysis */
  turnMetrics: TurnMetrics[];
  /** Working directory of the Claude instance — defines the sandbox boundary */
  projectRoot: string | null;
  /** CLAUDE.md scan results (if suspicious patterns found on session start) */
  claudeMdScan: ClaudeMdScanResult | null;
  /** Number of times the judge has returned a "hijacked" verdict in autonomous mode */
  hijackStrikes: number;
  /** Once the strike threshold is hit, the session is locked: every subsequent
   *  tool call is denied without running the pipeline. */
  lockedHijacked: boolean;
  /** OIDC sub of the API key owner who initiated this session, if any. */
  ownerSub: string | null;
  /** Email of the API key owner (display only). */
  ownerEmail: string | null;
  /**
   * Interactive/learn-mode intent stack. The LLM combines queued user
   * prompts at the next generation boundary, so the judge needs to
   * authorise tool calls against ALL goals the user has stated since
   * the last Stop, not just the most recent. Empty in autonomous mode
   * (overwrite-on-every-turn semantics there).
   *
   * Capped at MAX_INTENT_STACK in the legacy model. In the
   * history-active model this is a derived view (entries from
   * intentHistory whose ids are in activeIntentIds, ordered by
   * registeredAt asc) — but we keep this field as the single source
   * of truth during Step 1+2 for backwards compatibility, and write
   * to BOTH sides on each setActiveIntents call.
   */
  activeIntents: IntentEntry[];
  /**
   * Append-only ledger of every intent ever registered for this
   * session. Bounded by MAX_INTENT_HISTORY + Dynamo TTL. Step-1
   * addition: written by appendToHistory; populated lazily from
   * activeIntents when reading a legacy session that doesn't have
   * a history field yet.
   */
  intentHistory: IntentEntry[];
  /**
   * Subset of intentHistory by id that is currently live for the
   * judge. In Step 1 of the history-active migration this is kept
   * in sync with activeIntents (one-to-one). Steps 3+ allow the
   * active set to diverge from "the most recent N entries"
   * (revisits revive older entries, replacements drop specific
   * entries, etc).
   */
  activeIntentIds: string[];
  /**
   * id → last-touched epoch-ms map. Persisted alongside intentHistory
   * but in a separate field so /evaluate-driven LRU bookkeeping
   * doesn't require rewriting the (10–30KB) intentHistory blob on
   * every tool call. Active-set LRU eviction reads this map first,
   * falling back to the per-entry lastActiveAt / registeredAt for
   * entries that haven't been touched yet (e.g. legacy sessions
   * pre-migration).
   */
  intentLastActive: Record<string, number>;
  /**
   * Epoch ms of the last UserPromptSubmit. Combined with
   * lastPreToolUseAt and lastStopAt, gives us the turn state when the
   * NEXT prompt arrives (open / draining / closed).
   */
  lastUserPromptAt: number;
  /**
   * Epoch ms of the last PreToolUse on this session. If
   * lastPreToolUseAt > lastStopAt, the agent is currently mid-turn.
   * If lastUserPromptAt > lastStopAt AND lastPreToolUseAt > lastStopAt
   * AND lastPreToolUseAt > lastUserPromptAt, the user typed mid-tool-call
   * (DRAINING) — the LLM will combine the queued prompt with the
   * current generation, so we must append rather than replace.
   */
  lastPreToolUseAt: number;
  /**
   * Epoch ms of the last Stop hook firing on this session. Defines the
   * boundary between turns. On Stop we mark all stack entries
   * resolved=true; the next "new-task" push then clears them.
   */
  lastStopAt: number;
  /**
   * Snapshot of the user's local Claude Code allow/deny/ask lists,
   * copied in at /intent time from the cross-session
   * `jaid-user-permissions` table. Null until the hook first uploads
   * for this (user, project). /evaluate consults this on every tool
   * call (Phase 4) without ever hitting the cross-session table.
   */
  userPermissions: UserPermissionsLists | null;
}

// ---- Constants -----------------------------------------------------------

/**
 * Cap on the active-intent stack size in the legacy single-stack
 * model. Superseded by MAX_ACTIVE_INTENTS in the history-active
 * rollout; kept exported for any external callers (dashboard,
 * benchmark tooling) that reference it. New code should use
 * MAX_ACTIVE_INTENTS.
 *
 * @deprecated Use MAX_ACTIVE_INTENTS.
 */
export const MAX_INTENT_STACK = 5;

/**
 * Maximum number of entries kept LIVE in the history-active model's
 * active set. Distinct from MAX_INTENT_STACK (which is the legacy
 * single-stack cap). Set to 5 starting value — enough headroom for
 * nested sub-tasks (parent + intermediate + leaf) without diluting
 * the judge's anchor across too many goals. LRU-evicted on overflow.
 */
export const MAX_ACTIVE_INTENTS = 5;

/**
 * Maximum number of entries retained in the per-session intent
 * history (the append-only ledger). Bounded mostly by Dynamo's 30d
 * TTL; this cap is a safety valve for pathological sessions that
 * fire UserPromptSubmit thousands of times. Picking 500 = ~25 days
 * at one prompt every 70 minutes, well past normal session length.
 */
export const MAX_INTENT_HISTORY = 500;

/**
 * How long after Stop a resolved entry stays on the stack before being
 * implicitly evicted. Five minutes is generous for "I'll keep iterating
 * on this" without letting a long-idle session accumulate phantom goals.
 */
export const RESOLVED_INTENT_TTL_MS = 5 * 60 * 1000;
