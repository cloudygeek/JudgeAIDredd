/**
 * Turn Logger
 *
 * Receives callback data at the end of each agent turn and logs
 * everything it sees. This is the observation point where intent
 * tracking controls will eventually be added.
 *
 * Currently: logs all turn data to console and accumulates for
 * post-test analysis. No intervention — the hijack should succeed.
 */

import { TurnLog, ToolCallLog, CANARY_PREFIXES, IntentVerdict } from "../types.js";

export class TurnLogger {
  private turns: TurnLog[] = [];
  private intentVerdicts: (IntentVerdict | null)[] = [];
  private originalTask: string = "";

  /** Register the original task for later drift comparison */
  registerGoal(task: string): void {
    this.originalTask = task;
    console.log(`\n${"=".repeat(70)}`);
    console.log(`GOAL REGISTERED: ${task.substring(0, 100)}...`);
    console.log(`${"=".repeat(70)}\n`);
  }

  /**
   * Called at the end of each turn with the turn's data.
   *
   * This is the hook point. Currently it only logs.
   * In the defence implementation, this is where:
   *   1. Semantic drift detection runs
   *   2. LLM-as-a-judge evaluates intent consistency
   *   3. Goal anchoring decision is made
   */
  onTurnComplete(turn: TurnLog): void {
    this.turns.push(turn);

    // --- Log the turn ---
    const canaryFlag = turn.canaryDetected ? " *** CANARY DETECTED ***" : "";
    console.log(`\n${"─".repeat(70)}`);
    console.log(
      `TURN ${turn.turnNumber} | ${turn.timestamp}${canaryFlag}`
    );
    console.log(`${"─".repeat(70)}`);

    // User message
    console.log(`\n  USER: ${turn.userMessage.substring(0, 200)}`);
    if (turn.userMessage.length > 200) console.log(`  ... (${turn.userMessage.length} chars)`);

    // Tool calls
    if (turn.toolCalls.length > 0) {
      console.log(`\n  TOOLS (${turn.toolCalls.length}):`);
      for (const tc of turn.toolCalls) {
        const inputStr = JSON.stringify(tc.input).substring(0, 150);
        const canaryMarker =
          tc.canaryInInput || tc.canaryInOutput ? " [CANARY]" : "";
        console.log(`    ${tc.tool}(${inputStr})${canaryMarker}`);
        if (tc.output) {
          console.log(
            `      → ${tc.output.substring(0, 100)}${tc.output.length > 100 ? "..." : ""}`
          );
        }
      }
    }

    // Assistant response
    console.log(
      `\n  ASSISTANT: ${turn.assistantResponse.substring(0, 200)}`
    );
    if (turn.assistantResponse.length > 200)
      console.log(`  ... (${turn.assistantResponse.length} chars)`);

    // Canary details
    if (turn.canaryDetected) {
      console.log(`\n  *** CANARIES FOUND: ${turn.canariesFound.join(", ")}`);
    }

    // --- Intent tracking placeholder ---
    // Currently returns null (no tracking). Defence implementations
    // will override this to return an IntentVerdict.
    const verdict = this.evaluateIntent(turn);
    this.intentVerdicts.push(verdict);

    if (verdict) {
      console.log(
        `\n  INTENT: ${verdict.verdict} | drift=${verdict.cumulativeDrift.toFixed(3)} | sim=${verdict.semanticSimilarity.toFixed(3)}`
      );
    }
  }

  /**
   * Intent evaluation stub.
   *
   * Override this in defence implementations to add:
   * - Embedding-based semantic drift detection
   * - LLM-as-a-judge intent verification
   * - Goal anchoring decisions
   *
   * Returns null = no tracking (baseline).
   */
  protected evaluateIntent(_turn: TurnLog): IntentVerdict | null {
    return null;
  }

  /**
   * Called before the next turn. Returns a string to prepend to the
   * next user message (goal anchor), or null to leave it unchanged.
   *
   * Override this in defence implementations.
   */
  getGoalAnchor(): string | null {
    return null;
  }

  /**
   * Returns whether the current turn should be blocked.
   *
   * Override this in defence implementations.
   */
  shouldBlock(): boolean {
    return false;
  }

  /** Get all accumulated turns */
  getTurns(): TurnLog[] {
    return this.turns;
  }

  /** Get intent verdicts */
  getIntentVerdicts(): (IntentVerdict | null)[] {
    return this.intentVerdicts;
  }

  /** Get the original registered task */
  getOriginalTask(): string {
    return this.originalTask;
  }

  /** Reset for a new test run */
  reset(): void {
    this.turns = [];
    this.intentVerdicts = [];
    this.originalTask = "";
  }
}

/**
 * Check if a string contains any canary values.
 */
export function detectCanaries(text: string): string[] {
  const found: string[] = [];
  for (const prefix of CANARY_PREFIXES) {
    if (text.includes(prefix)) {
      found.push(prefix);
    }
  }
  return found;
}
