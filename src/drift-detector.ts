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
  private taskEmbedding: number[] | null = null;
  private turnSimilarities: number[] = [];
  private previousSimilarity: number = 1.0;

  constructor(embeddingModel = "nomic-embed-text") {
    this.embeddingModel = embeddingModel;
  }

  /**
   * Register the original task. Computes and caches its embedding.
   */
  async registerGoal(task: string): Promise<void> {
    const embeddings = await embedAny(task, this.embeddingModel);
    this.taskEmbedding = embeddings[0];
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
   */
  async evaluate(turnSummary: string): Promise<DriftScore> {
    if (!this.taskEmbedding) {
      throw new Error("Goal not registered. Call registerGoal() first.");
    }

    const start = Date.now();
    const embeddings = await embedAny(turnSummary, this.embeddingModel);
    const embedTimeMs = Date.now() - start;

    const turnEmbedding = embeddings[0];
    const similarity = cosineSimilarity(this.taskEmbedding, turnEmbedding);

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
    this.taskEmbedding = null;
    this.turnSimilarities = [];
    this.previousSimilarity = 1.0;
  }
}
