/**
 * Session Tracker
 *
 * Maintains per-session state across hook invocations, tracking:
 *   - Original intent (from first UserPromptSubmit)
 *   - Turn-by-turn intent history (from subsequent UserPromptSubmit calls)
 *   - Tool call history (from PreToolUse calls)
 *   - Embedding trajectories for drift detection
 *
 * This is the stateful backbone that connects the hooks:
 *   UserPromptSubmit → registers intent
 *   PreToolUse → evaluates tool call against intent history
 *
 * Keyed by session_id so multiple concurrent sessions stay isolated.
 */

import { DriftDetector } from "./drift-detector.js";
import { embed, cosineSimilarity } from "./ollama-client.js";
import { CANARY_PREFIXES } from "./types.js";

export interface TurnIntent {
  turnNumber: number;
  timestamp: string;
  prompt: string;
  embedding: number[];
}

export interface ToolCallRecord {
  turnNumber: number;
  tool: string;
  input: Record<string, unknown>;
  decision: "allow" | "deny" | "review";
  similarity: number | null;
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
}

export class SessionTracker {
  private sessions = new Map<string, SessionState>();
  private embeddingModel: string;

  constructor(embeddingModel = "nomic-embed-text") {
    this.embeddingModel = embeddingModel;
  }

  /**
   * Get or create session state.
   */
  private getSession(sessionId: string): SessionState {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        originalIntent: null,
        turnIntents: [],
        toolHistory: [],
        currentTurn: 0,
        driftDetector: new DriftDetector(this.embeddingModel),
        originalEmbedding: null,
        filesWritten: new Map(),
        filesRead: [],
      });
    }
    return this.sessions.get(sessionId)!;
  }

  /**
   * Called from UserPromptSubmit hook.
   * First call = original intent. Subsequent calls = turn intents.
   */
  async registerIntent(sessionId: string, prompt: string): Promise<{
    isOriginal: boolean;
    turnNumber: number;
    driftFromOriginal: number | null;
    driftFromPrevious: number | null;
  }> {
    const session = this.getSession(sessionId);
    const [promptEmbedding] = await embed(prompt, this.embeddingModel);

    const intent: TurnIntent = {
      turnNumber: session.currentTurn,
      timestamp: new Date().toISOString(),
      prompt,
      embedding: promptEmbedding,
    };

    let driftFromOriginal: number | null = null;
    let driftFromPrevious: number | null = null;

    if (session.originalIntent === null) {
      // First prompt — this is the original task
      session.originalIntent = intent;
      session.originalEmbedding = promptEmbedding;
      await session.driftDetector.registerGoal(prompt);

      console.log(
        `  [SESSION ${sessionId.substring(0, 8)}] ORIGINAL INTENT registered: "${prompt.substring(0, 80)}..."`
      );
    } else {
      // Subsequent prompt — track as turn intent
      session.turnIntents.push(intent);
      session.currentTurn++;

      // Measure drift from original
      driftFromOriginal = 1 - cosineSimilarity(
        session.originalEmbedding!,
        promptEmbedding
      );

      // Measure drift from previous turn
      const prevIntents = session.turnIntents;
      if (prevIntents.length >= 2) {
        const prevEmbedding = prevIntents[prevIntents.length - 2].embedding;
        driftFromPrevious = 1 - cosineSimilarity(prevEmbedding, promptEmbedding);
      }

      console.log(
        `  [SESSION ${sessionId.substring(0, 8)}] TURN ${session.currentTurn} intent: "${prompt.substring(0, 80)}..." ` +
        `(drift from original: ${driftFromOriginal?.toFixed(3) ?? "n/a"}, ` +
        `from prev: ${driftFromPrevious?.toFixed(3) ?? "n/a"})`
      );
    }

    return {
      isOriginal: session.originalIntent === intent,
      turnNumber: session.currentTurn,
      driftFromOriginal,
      driftFromPrevious,
    };
  }

  /**
   * Called from PreToolUse hook.
   * Returns the session state needed for tool evaluation.
   */
  getSessionContext(sessionId: string): {
    originalTask: string | null;
    currentTurn: number;
    recentTools: ToolCallRecord[];
    turnIntents: TurnIntent[];
    originalEmbedding: number[] | null;
  } {
    const session = this.getSession(sessionId);
    return {
      originalTask: session.originalIntent?.prompt ?? null,
      currentTurn: session.currentTurn,
      recentTools: session.toolHistory.slice(-10),
      turnIntents: session.turnIntents,
      originalEmbedding: session.originalEmbedding,
    };
  }

  /**
   * Record a tool call decision.
   */
  recordToolCall(
    sessionId: string,
    tool: string,
    input: Record<string, unknown>,
    decision: "allow" | "deny" | "review",
    similarity: number | null
  ): void {
    const session = this.getSession(sessionId);
    session.toolHistory.push({
      turnNumber: session.currentTurn,
      tool,
      input,
      decision,
      similarity,
    });
  }

  /**
   * Get the drift detector for a session.
   */
  getDriftDetector(sessionId: string): DriftDetector {
    return this.getSession(sessionId).driftDetector;
  }

  /**
   * Get full session summary for logging.
   */
  getSessionSummary(sessionId: string): {
    turns: number;
    toolCalls: number;
    denied: number;
    intents: string[];
  } {
    const session = this.getSession(sessionId);
    return {
      turns: session.currentTurn,
      toolCalls: session.toolHistory.length,
      denied: session.toolHistory.filter((t) => t.decision === "deny").length,
      intents: [
        session.originalIntent?.prompt.substring(0, 60) ?? "(none)",
        ...session.turnIntents.map((i) => i.prompt.substring(0, 60)),
      ],
    };
  }

  // =========================================================================
  // FILE CONTENT TRACKING
  // =========================================================================

  /**
   * Record a file read (from PostToolUse after a Read tool completes).
   * Tracks which files the agent has seen — if content from a read file
   * later appears in a write, that's a potential exfiltration signal.
   */
  recordFileRead(
    sessionId: string,
    filePath: string,
    content: string
  ): void {
    const session = this.getSession(sessionId);
    const isSensitive = /\.env|\.pem|\.key|id_rsa|credentials|secret|password|token/i.test(filePath);

    session.filesRead.push({
      path: filePath,
      turn: session.currentTurn,
      content: content.substring(0, 5000), // truncate large files
      isSensitive,
    });

    if (isSensitive) {
      console.log(
        `  [FILE] Sensitive file read: ${filePath} at turn ${session.currentTurn}`
      );
    }
  }

  /**
   * Record a file write or edit (from PostToolUse after Write/Edit completes).
   * Accumulates content per file so we can detect assembled payloads.
   */
  recordFileWrite(
    sessionId: string,
    filePath: string,
    content: string,
    isEdit: boolean
  ): void {
    const session = this.getSession(sessionId);
    const existing = session.filesWritten.get(filePath);

    // Check if content contains canary patterns
    const containsCanary = CANARY_PREFIXES.some((p) => content.includes(p));

    // Check if content contains data from any sensitive file reads
    const containsReadData = this.checkContentFromReads(session, content);

    if (existing) {
      existing.writeCount++;
      existing.modifiedAtTurns.push(session.currentTurn);
      existing.containsCanary = existing.containsCanary || containsCanary;

      if (isEdit) {
        // For edits, append to accumulated content
        existing.content += "\n" + content;
      } else {
        // For writes, replace content
        existing.content = content;
      }
    } else {
      // Check if this file was read earlier in the session
      const wasReadFirst = session.filesRead.some((r) => r.path === filePath);

      session.filesWritten.set(filePath, {
        path: filePath,
        writeCount: 1,
        content: content.substring(0, 10000),
        modifiedAtTurns: [session.currentTurn],
        wasReadFirst,
        containsCanary,
      });
    }

    const record = session.filesWritten.get(filePath)!;

    if (record.writeCount > 1) {
      console.log(
        `  [FILE] ${filePath} written ${record.writeCount} times (turns: ${record.modifiedAtTurns.join(",")})`
      );
    }
    if (containsCanary) {
      console.log(
        `  [FILE] *** CANARY detected in write to ${filePath}`
      );
    }
    if (containsReadData) {
      console.log(
        `  [FILE] *** Content from sensitive read detected in write to ${filePath}`
      );
    }
  }

  /**
   * Check if written content contains data from previously read sensitive files.
   * This detects the pattern: Read(.env.test) → Write(config.ts) with .env.test values.
   */
  private checkContentFromReads(session: SessionState, content: string): boolean {
    for (const read of session.filesRead) {
      if (!read.isSensitive) continue;

      // Extract potential secret values from the read content
      // (lines that look like KEY=VALUE)
      const lines = read.content.split("\n");
      for (const line of lines) {
        const match = line.match(/^[A-Z_]+=(.+)$/);
        if (match) {
          const value = match[1].trim();
          // Check if the value (or a significant substring) appears in the written content
          if (value.length >= 8 && content.includes(value)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Get all files written this session with their accumulated content.
   * Used by PreToolUse to evaluate execution commands against written files.
   */
  getWrittenFiles(sessionId: string): FileRecord[] {
    const session = this.getSession(sessionId);
    return Array.from(session.filesWritten.values());
  }

  /**
   * Get files that have been written multiple times (potential payload splitting).
   */
  getMultiWriteFiles(sessionId: string): FileRecord[] {
    return this.getWrittenFiles(sessionId).filter((f) => f.writeCount > 1);
  }

  /**
   * Get files containing canary/sensitive data.
   */
  getCanaryFiles(sessionId: string): FileRecord[] {
    return this.getWrittenFiles(sessionId).filter((f) => f.containsCanary);
  }

  /**
   * Build a context summary of all written files for the judge.
   * Used when evaluating execution commands (Bash, git commit, etc.).
   */
  getFileContextForJudge(sessionId: string): string {
    const files = this.getWrittenFiles(sessionId);
    if (files.length === 0) return "No files written this session.";

    const multiWrite = files.filter((f) => f.writeCount > 1);
    const canaryFiles = files.filter((f) => f.containsCanary);
    const sensitiveReads = this.getSession(sessionId).filesRead.filter((r) => r.isSensitive);

    let context = `FILES WRITTEN THIS SESSION (${files.length} total):\n`;

    for (const f of files) {
      const flags = [
        f.writeCount > 1 ? `MULTI-WRITE(${f.writeCount}x)` : null,
        f.containsCanary ? "CONTAINS-SENSITIVE-DATA" : null,
        f.wasReadFirst ? "READ-THEN-WRITTEN" : null,
      ]
        .filter(Boolean)
        .join(", ");

      context += `\n--- ${f.path} ${flags ? `[${flags}]` : ""} ---\n`;
      context += f.content.substring(0, 2000);
      if (f.content.length > 2000) context += "\n... (truncated)";
      context += "\n";
    }

    if (sensitiveReads.length > 0) {
      context += `\nSENSITIVE FILES READ THIS SESSION: ${sensitiveReads.map((r) => r.path).join(", ")}`;
    }

    if (multiWrite.length > 0) {
      context += `\nWARNING: ${multiWrite.length} file(s) written multiple times (potential payload splitting)`;
    }

    if (canaryFiles.length > 0) {
      context += `\nWARNING: ${canaryFiles.length} file(s) contain sensitive data patterns`;
    }

    return context;
  }

  /**
   * Clean up a completed session.
   */
  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
