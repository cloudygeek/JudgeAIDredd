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
    let skippedDimMismatch = 0;
    for (const ge of this.goalEmbeddings) {
      // A goal embedding of a different dimensionality is UNUSABLE, not an
      // error. This happens whenever the deployment's EMBEDDING_MODEL changes
      // while sessions persisted under the old one are still live: a session
      // rehydrated from Dynamo carries goal vectors made by, say,
      // eu.cohere.embed-v4:0, and gets compared against a fresh
      // nomic-embed-text vector (768 dims). cosineSimilarity throws on
      // mismatch, and this call site is NOT inside a try — the throw would
      // escape interceptor.evaluate, 500 the /evaluate request, and leave the
      // hook with no decision. Dredd would be effectively offline for every
      // pre-existing session, which is exactly the shape of failure the
      // self-host migration would have produced. See
      // docs/plan-selfhost-studio-2026-08-26.md.
      if (ge.length !== turnEmbedding.length) {
        skippedDimMismatch++;
        continue;
      }
      const s = cosineSimilarity(ge, turnEmbedding);
      if (s > similarity) similarity = s;
    }

    if (similarity === -Infinity) {
      // No comparable goal vector survived. Report maximum drift rather than
      // inventing a similarity: downstream, low similarity ESCALATES to the
      // judge, so the safe direction is "we don't know, go look" — never
      // "looks fine". The session re-embeds its goal on the next /intent, so
      // this degrades for a turn rather than permanently.
      similarity = 0;
      if (skippedDimMismatch > 0) {
        console.warn(
          `  [drift] all ${skippedDimMismatch} goal embedding(s) have a different ` +
          `dimension to ${this.embeddingModel} (${turnEmbedding.length}) — ` +
          `treating as max drift and escalating. Embedding model changed mid-session?`,
        );
      }
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
