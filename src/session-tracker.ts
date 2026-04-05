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

  /**
   * Clean up a completed session.
   */
  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
