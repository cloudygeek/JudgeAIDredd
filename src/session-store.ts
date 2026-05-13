/**
 * SessionStore interface.
 *
 * Abstracts the per-session state that Dredd holds across hook invocations.
 * Implementations:
 *   - `InMemorySessionStore` — process-local Map, original behaviour.
 *   - `DynamoSessionStore`   — DynamoDB-backed, for horizontal scale.
 *   - `CachedSessionStore`   — write-through LRU wrapper around Dynamo.
 *
 * All methods are async so a Dynamo-backed implementation can await I/O.
 * The in-memory implementation resolves synchronously under the hood —
 * there is no meaningful latency cost.
 *
 * The only exception is `classifyDrift`, which is pure logic with no I/O,
 * and `getDriftDetector`, which returns a live in-process object that
 * must be synchronously accessible to the hot path in pretool-interceptor.
 */

import type { DriftDetector } from "./drift-detector.js";
import type { ClaudeMdScanResult } from "./claudemd-scanner.js";
import type {
  ImageBlock,
  TurnIntent,
  IntentEntry,
  ToolCallRecord,
  FileRecord,
  FileReadRecord,
  EnvVarRecord,
  TurnMetrics,
  SessionState,
  UserPermissionsLists,
} from "./session-tracker.js";

export type {
  ImageBlock,
  TurnIntent,
  IntentEntry,
  ToolCallRecord,
  FileRecord,
  FileReadRecord,
  EnvVarRecord,
  TurnMetrics,
  SessionState,
  UserPermissionsLists,
};

export type DriftClassification = "on-task" | "scope-creep" | "drifting" | "hijacked";

/** Minimal per-session metadata returned by the list endpoint. */
export interface SessionSummary {
  sessionId: string;
  startedAt: string | null;
  endedAt?: string | null;
  originalTask: string | null;
  currentTurn: number;
  hijackStrikes: number;
  lockedHijacked: boolean;
  /** OIDC sub of the API key owner who initiated this session, if any.
   *  Used by the dashboard to scope sessions to the signed-in user. */
  ownerSub?: string | null;
  /** Display convenience — same source as ownerSub. */
  ownerEmail?: string | null;
}

export interface SessionStore {
  // ---- bulk snapshot ------------------------------------------------------
  /**
   * Return a full in-memory snapshot of the session, or `null` if unknown.
   * Used by `CachedSessionStore` to warm its in-memory replica from a remote
   * backend without a per-method roundtrip per access.
   */
  loadSession(sessionId: string): Promise<SessionState | null>;

  /**
   * List recent sessions, newest first. Powers the dashboard /api/sessions.
   * Implementations should cap at `limit` (default 50) to keep responses
   * small. The Dynamo implementation queries GSI1; in-memory reads from
   * the live map.
   */
  listSessions(limit?: number): Promise<SessionSummary[]>;

  // ---- session lifecycle --------------------------------------------------
  setProjectRoot(sessionId: string, cwd: string): Promise<void>;
  getProjectRoot(sessionId: string): Promise<string | null>;

  /** Stamp the session with the API-key owner identity. Called from
   *  /intent once the bearer token has been validated. Idempotent —
   *  first writer wins, subsequent calls are no-ops, so a key swap
   *  mid-session can't change ownership. */
  setSessionOwner(
    sessionId: string,
    ownerSub: string,
    ownerEmail: string | null,
  ): Promise<void>;
  getSessionOwner(sessionId: string): Promise<{ ownerSub: string | null; ownerEmail: string | null }>;

  recordClaudeMdScan(sessionId: string, scan: ClaudeMdScanResult): Promise<void>;
  getClaudeMdScan(sessionId: string): Promise<ClaudeMdScanResult | null>;

  /** Copy the user's allow/deny/ask lists into the session. Idempotent —
   *  called on every /intent with the lists looked up from
   *  `jaid-user-permissions`. /evaluate reads via getUserPermissions. */
  setUserPermissions(sessionId: string, lists: UserPermissionsLists): Promise<void>;
  getUserPermissions(sessionId: string): Promise<UserPermissionsLists | null>;

  pivotSession(sessionId: string, reason: string): Promise<void>;
  endSession(sessionId: string): Promise<void>;

  // ---- turn-state markers (interactive/learn intent stack) ---------------
  /**
   * Record that a UserPromptSubmit hook fired for this session and
   * return the prior turn-state markers so the caller can decide
   * whether the prompt is open / draining / closed. Updates
   * lastUserPromptAt to now() in the same call.
   */
  noteUserPromptSubmit(sessionId: string): Promise<{
    /** ms since epoch — was 0 if never set. */
    prevUserPromptAt: number;
    prevPreToolUseAt: number;
    prevStopAt: number;
  }>;
  /** Record that a PreToolUse hook fired (intent stack timing only). */
  notePreToolUse(sessionId: string): Promise<void>;
  /**
   * Record that a Stop hook fired and mark all intent stack entries
   * resolved=true. Returns nothing — the next /intent will then evict
   * resolved entries on a "new-task" classification.
   */
  noteStop(sessionId: string): Promise<void>;

  // ---- intent stack (interactive/learn) ----------------------------------
  /**
   * Read-only access to the active intent stack — used by the judge
   * pipeline to render multi-goal context and by drift evaluation to
   * sync the DriftDetector's goalEmbeddings.
   *
   * In the legacy single-stack model, this returns the stored stack
   * directly. In the history-active model (Step 1+ of the
   * intent-history-active migration), this resolves activeIntentIds
   * against intentHistory and returns the materialised entries.
   * Either way, the caller-facing contract is unchanged.
   */
  getActiveIntents(sessionId: string): Promise<IntentEntry[]>;
  /**
   * Replace the intent stack and re-seed the DriftDetector's goal
   * embeddings to match. Used by the hook on every UserPromptSubmit
   * after applyIntentStackUpdate has decided the new shape.
   *
   * @deprecated New code should use appendToHistory + activateIntent
   *   + markIntentResolved. setActiveIntents stays for the mode-flip
   *   path (clears the active set) and as the migration shim's write
   *   path during Steps 1-2 of the history-active rollout.
   */
  setActiveIntents(sessionId: string, entries: IntentEntry[]): Promise<void>;

  // ---- intent history + active set (history-active model) ----------------
  /**
   * Append a new entry to the session's intent history. Returns the
   * entry's id (generated if absent). History is append-only and
   * bounded only by MAX_INTENT_HISTORY + Dynamo TTL — entries are NOT
   * deleted as a side effect of new prompts arriving. Used by
   * applyIntentStackUpdate to record every intent the session ever
   * had, regardless of whether it ends up live.
   */
  appendToHistory(sessionId: string, entry: IntentEntry): Promise<string>;
  /**
   * Read the full intent history for a session, newest-last. Used by
   * the LLM classifier to decide revisit/replacement and by the
   * dashboard to render the session timeline. Optional limit caps
   * the returned size to the most recent N entries.
   */
  getIntentHistory(sessionId: string, limit?: number): Promise<IntentEntry[]>;
  /**
   * Mark a set of history entry ids as resolved (kept in history but
   * removed from the active set). Used when a topic-switch /
   * replacement / revisit causes prior actives to no longer be live.
   */
  markIntentResolved(sessionId: string, entryIds: string[]): Promise<void>;
  /**
   * Add a history entry id to the active set. Used by the classifier
   * when promoting an entry to live (e.g. on revisit, where a
   * previously-resolved entry is brought back). Caps active-set size
   * at MAX_ACTIVE_INTENTS via LRU eviction (drops the oldest
   * lastActiveAt entry first).
   */
  activateIntent(sessionId: string, entryId: string): Promise<void>;
  /**
   * Update the lastActiveAt timestamp for an entry. Called by
   * /evaluate when an entry is materialised into the activeIntents
   * passed to the interceptor. Drives LRU eviction in the active set.
   *
   * Coalesces in the implementation — see DynamoSessionStore's
   * touchActiveIntent for the buffer + flush mechanic.
   */
  touchActiveIntent(sessionId: string, entryId: string): Promise<void>;
  /**
   * Read the per-session intentLastActive map. Used by
   * applyIntentStackUpdate to drive LRU eviction without inflating
   * each IntentEntry with a separate lastActiveAt field. Returns an
   * empty record for unknown sessions.
   */
  getIntentLastActive(sessionId: string): Promise<Record<string, number>>;
  /**
   * Update the classifierSource tag on a single history entry.
   * Used by the async LLM classifier to mark an entry "llm-confirmed"
   * without rewriting the entire intentHistory blob (which the
   * common-case LLM-agreed-with-embedding path was doing on every
   * /intent — wasteful enough to bite the table's WCU budget).
   */
  setEntryClassifierSource(
    sessionId: string,
    entryId: string,
    source: "embedding" | "llm" | "llm-confirmed" | "embedding-fallback-timeout",
  ): Promise<void>;

  // ---- intent & drift -----------------------------------------------------
  registerIntent(
    sessionId: string,
    prompt: string,
    skipDrift?: boolean,
    images?: ImageBlock[],
    /**
     * Whether the prompt was classified as a short confirmation
     * ("yes" / "ok" / "option 2" / etc.) of the previous turn. Computed by
     * the caller (server-hook.ts:handleIntent) and persisted on the
     * TurnIntent so the dashboard can render goal history without
     * confirmation noise.
     */
    isConfirmation?: boolean,
  ): Promise<{
    isOriginal: boolean;
    turnNumber: number;
    driftFromOriginal: number | null;
    driftFromPrevious: number | null;
  }>;

  /**
   * Overwrite the session's original intent. Called from autonomous-
   * mode topic-switch detection so the judge's anchor moves when the
   * user genuinely pivots topics. Resets the drift detector and
   * clears accumulated turnMetrics so subsequent measurements are
   * against the new goal, not the old one.
   *
   * Interactive-mode sessions don't use this — the intent stack does
   * the equivalent work via setActiveIntents.
   */
  replaceOriginalIntent(sessionId: string, prompt: string): Promise<void>;

  getSessionContext(sessionId: string): Promise<{
    originalTask: string | null;
    currentTurn: number;
    recentTools: ToolCallRecord[];
    turnIntents: TurnIntent[];
    originalEmbedding: number[] | null;
    intentImages: ImageBlock[] | undefined;
  }>;

  /**
   * Synchronous on purpose — the drift detector is a live in-process object
   * whose state (task embedding, turn similarity history) lives alongside
   * the session and is re-seeded on cache-load. Callers on the hot path
   * invoke `.evaluate()` on it directly.
   */
  getDriftDetector(sessionId: string): DriftDetector;

  /** Pure logic, no I/O. */
  classifyDrift(drift: number | null): DriftClassification;

  getGoalReminder(sessionId: string, driftFromOriginal: number | null): Promise<string | null>;

  // ---- tool decisions -----------------------------------------------------
  recordToolCall(
    sessionId: string,
    tool: string,
    input: Record<string, unknown>,
    decision: "allow" | "deny" | "review",
    similarity: number | null,
    /** Claude Code's per-call identifier (toolu_*) — optional for
     *  back-compat with benchmark harnesses that don't emit one. */
    toolUseId?: string | null,
  ): Promise<void>;

  recordHijackStrike(
    sessionId: string,
    threshold: number,
  ): Promise<{ strikes: number; locked: boolean; justLocked: boolean }>;

  isLocked(sessionId: string): Promise<boolean>;
  getHijackStrikes(sessionId: string): Promise<number>;

  // ---- files --------------------------------------------------------------
  recordFileRead(sessionId: string, filePath: string, content: string): Promise<void>;
  recordFileWrite(
    sessionId: string,
    filePath: string,
    content: string,
    isEdit: boolean,
  ): Promise<void>;

  getWrittenFiles(sessionId: string): Promise<FileRecord[]>;
  getMultiWriteFiles(sessionId: string): Promise<FileRecord[]>;
  getCanaryFiles(sessionId: string): Promise<FileRecord[]>;

  getFileContextForJudge(sessionId: string): Promise<string>;

  // ---- env vars -----------------------------------------------------------
  recordEnvVar(sessionId: string, command: string): Promise<void>;
  getEnvVars(sessionId: string): Promise<EnvVarRecord[]>;
  getSensitiveEnvVars(sessionId: string): Promise<EnvVarRecord[]>;

  // ---- turn metrics & summaries ------------------------------------------
  recordTurnMetrics(
    sessionId: string,
    driftFromOriginal: number | null,
    driftFromPrevious: number | null,
    toolCallCount: number,
    toolCallsDenied: number,
    goalReminderInjected: boolean,
    blocked: boolean,
  ): Promise<void>;

  getTurnMetrics(sessionId: string): Promise<TurnMetrics[]>;

  getSessionSummary(sessionId: string): Promise<{
    turns: number;
    toolCalls: number;
    denied: number;
    intents: string[];
  }>;

  getFullSessionSummary(sessionId: string): Promise<{
    turns: number;
    toolCalls: number;
    denied: number;
    intents: string[];
    filesWritten: number;
    filesWithCanary: number;
    multiWriteFiles: number;
    envVarsSet: number;
    sensitiveEnvVars: number;
    turnMetrics: TurnMetrics[];
  }>;
}
