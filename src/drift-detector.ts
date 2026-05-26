/**
 * Drift Detector
 *
 * Embedding-based semantic drift detection using a local model via Ollama.
 * Computes similarity between the original task and each turn's actions,
 * tracking cumulative drift and sudden shifts.
 *
 * This is Layer 1 of the defence: fast (~50ms per turn), deterministic
 * given the same embeddings, and runs entirely locally.
 */

import { embedAny, cosineSimilarity } from "./ollama-client.js";

export interface DriftScore {
  /** Cosine similarity between this turn's action and the original task (0-1) */
  similarity: number;
  /** Mean similarity across all turns so far (0-1, higher = more aligned) */
  meanSimilarity: number;
  /** Cumulative drift: 1 - meanSimilarity (0-1, higher = more drifted) */
  cumulativeDrift: number;
  /** Absolute change in similarity from previous turn */
  turnDelta: number;
  /** Number of turns tracked */
  turnCount: number;
  /** Embedding computation time in ms */
  embedTimeMs: number;
}

export class DriftDetector {
  private embeddingModel: string;
  /**
   * The goal embeddings the agent is currently authorised to act on. In
   * autonomous mode this is always a single embedding (every new
   * UserPromptSubmit replaces it). In interactive/learn mode it is the
   * stack of active intents — a tool call is on-task if it semantically
   * matches ANY active intent (min cosine distance / max cosine
   * similarity across the stack).
   */
  private goalEmbeddings: number[][] = [];
  private turnSimilarities: number[] = [];
  private previousSimilarity: number = 1.0;

  constructor(embeddingModel = "nomic-embed-text") {
    this.embeddingModel = embeddingModel;
  }

  /**
   * Register the operative goal. Replaces the active goal stack with a
   * single entry (autonomous mode and the first interactive turn).
   * Caches the goal's embedding.
   */
  async registerGoal(task: string, auth?: import("./byot/types.js").BedrockAuth): Promise<void> {
    const embeddings = await embedAny(task, this.embeddingModel, auth);
    this.goalEmbeddings = [embeddings[0]];
    this.turnSimilarities = [];
    this.previousSimilarity = 1.0;
  }

  /**
   * Replace the goal stack with a list of pre-computed embeddings.
   * Used by interactive/learn mode where the SessionState owns the
   * authoritative IntentEntry stack and re-syncs the detector on every
   * /intent. Embeddings are passed in (not re-computed) so we don't
   * pay the embedAny cost again — the stack maintainer already has
   * them from the IntentEntry.
   *
   * Empty input clears the stack; the next evaluate() call will throw.
   */
  setGoalEmbeddings(embeddings: number[][]): void {
    this.goalEmbeddings = embeddings.filter((e) => e && e.length > 0);
    this.turnSimilarities = [];
    this.previousSimilarity = 1.0;
  }

  /**
   * Summarise a turn's activity into a text string for embedding.
   * Focuses on WHAT was done, not conversational content.
   */
  summariseTurn(
    userMessage: string,
    toolCalls: { tool: string; input: Record<string, unknown> }[],
    assistantResponse: string
  ): string {
    const toolSummary =
      toolCalls.length > 0
        ? toolCalls
            .map((tc) => {
              const params = Object.entries(tc.input)
                .map(([k, v]) => `${k}=${JSON.stringify(v).substring(0, 80)}`)
                .join(", ");
              return `${tc.tool}(${params})`;
            })
            .join("; ")
        : "no tools used";

    return (
      `User request: ${userMessage.substring(0, 200)}. ` +
      `Agent actions: ${toolSummary}. ` +
      `Agent response summary: ${assistantResponse.substring(0, 200)}`
    );
  }

  /**
   * Evaluate semantic drift for a turn.
   *
   * When multiple goals are active (interactive/learn stack), the action
   * is on-task if it matches any of them. We take the MAX similarity
   * across the stack — equivalent to MIN cosine distance — so an action
   * advancing a queued sub-goal isn't flagged as drifted just because it
   * diverges from the original.
   */
  async evaluate(turnSummary: string, auth?: import("./byot/types.js").BedrockAuth): Promise<DriftScore> {
    if (this.goalEmbeddings.length === 0) {
      throw new Error("Goal not registered. Call registerGoal() first.");
    }

    const start = Date.now();
    const embeddings = await embedAny(turnSummary, this.embeddingModel, auth);
    const embedTimeMs = Date.now() - start;

    const turnEmbedding = embeddings[0];
    let similarity = -Infinity;
    for (const ge of this.goalEmbeddings) {
      const s = cosineSimilarity(ge, turnEmbedding);
      if (s > similarity) similarity = s;
    }

    this.turnSimilarities.push(similarity);

    const meanSimilarity =
      this.turnSimilarities.reduce((a, b) => a + b, 0) /
      this.turnSimilarities.length;

    const turnDelta = Math.abs(similarity - this.previousSimilarity);
    this.previousSimilarity = similarity;

    return {
      similarity,
      meanSimilarity,
      cumulativeDrift: 1 - meanSimilarity,
      turnDelta,
      turnCount: this.turnSimilarities.length,
      embedTimeMs,
    };
  }

  /**
   * Get the full similarity history.
   */
  getHistory(): number[] {
    return [...this.turnSimilarities];
  }

  /**
   * Reset state for a new test run.
   */
  reset(): void {
    this.goalEmbeddings = [];
    this.turnSimilarities = [];
    this.previousSimilarity = 1.0;
  }
}
