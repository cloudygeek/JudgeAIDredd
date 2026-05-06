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
  ToolCallRecord,
  FileRecord,
  FileReadRecord,
  EnvVarRecord,
  TurnMetrics,
  SessionState,
} from "./session-tracker.js";

export type {
  ImageBlock,
  TurnIntent,
  ToolCallRecord,
  FileRecord,
  FileReadRecord,
  EnvVarRecord,
  TurnMetrics,
  SessionState,
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

  pivotSession(sessionId: string, reason: string): Promise<void>;
  endSession(sessionId: string): Promise<void>;

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
