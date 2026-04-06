/**
 * PreToolUse Interceptor
 *
 * Evaluates every tool call BEFORE execution using a three-stage pipeline:
 *
 *   Stage 1: Policy engine (instant)
 *     → ALLOW: skip to execution
 *     → DENY:  block immediately
 *     → REVIEW: proceed to Stage 2
 *
 *   Stage 2: Embedding drift check (~50ms)
 *     Compares "tool + parameters" against original task embedding.
 *     If similarity is high → allow
 *     If drift detected → proceed to Stage 3
 *
 *   Stage 3: LLM judge (~5-15s)
 *     Asks local LLM: "Given original task X, is tool call Y appropriate?"
 *     Returns allow/deny.
 *
 * This runs at PreToolUse, so blocked tools never execute.
 * The agent receives a rejection message and must try a different approach.
 */

import {
  evaluateToolPolicy,
  formatPolicyResult,
  type PolicyResult,
} from "./tool-policy.js";
import { DriftDetector } from "./drift-detector.js";
import { IntentJudge, type JudgeVerdict } from "./intent-judge.js";
import { checkOllama } from "./ollama-client.js";

export interface InterceptorConfig {
  embeddingModel?: string;
  judgeModel?: string;
  /** Similarity threshold below which the judge is invoked (default: 0.5) */
  reviewThreshold?: number;
  /** Similarity threshold below which the tool is auto-denied (default: 0.3) */
  denyThreshold?: number;
  /** Enable LLM judge for REVIEW decisions (default: true) */
  enableJudge?: boolean;
}

const DEFAULTS: Required<InterceptorConfig> = {
  embeddingModel: "nomic-embed-text",
  judgeModel: "nemotron-3-super",
  reviewThreshold: 0.5,
  denyThreshold: 0.3,
  enableJudge: true,
};

export interface InterceptionResult {
  allowed: boolean;
  tool: string;
  input: Record<string, unknown>;
  /** Which stage made the decision */
  stage: "policy-allow" | "policy-deny" | "drift-allow" | "drift-deny" | "judge-allow" | "judge-deny";
  policyResult: PolicyResult;
  /** Embedding similarity (null if not evaluated) */
  similarity: number | null;
  /** Judge verdict (null if not invoked) */
  judgeVerdict: JudgeVerdict | null;
  /** Total evaluation time in ms */
  evaluationMs: number;
  /** Reason for the decision */
  reason: string;
}

export class PreToolInterceptor {
  private config: Required<InterceptorConfig>;
  private driftDetector: DriftDetector;
  private judge: IntentJudge;
  private originalTask: string = "";
  private toolLog: InterceptionResult[] = [];

  constructor(config?: InterceptorConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.driftDetector = new DriftDetector(this.config.embeddingModel);
    this.judge = new IntentJudge(this.config.judgeModel);
  }

  async preflight(): Promise<void> {
    const { ok, missing } = await checkOllama(
      this.config.embeddingModel,
      this.config.judgeModel
    );
    if (!ok) {
      console.error(`Missing Ollama models: ${missing.join(", ")}`);
      for (const m of missing) {
        console.error(`  ollama pull ${m}`);
      }
      throw new Error(`Missing Ollama models: ${missing.join(", ")}`);
    }
  }

  async registerGoal(task: string): Promise<void> {
    this.originalTask = task;
    await this.driftDetector.registerGoal(task);
  }

  /**
   * Evaluate a tool call. Returns whether it should be allowed.
   * This is the PreToolUse hook implementation.
   *
   * @param fileContext — optional assembled file content from SessionTracker.
   *   When a Bash command references files written this session, pass
   *   getFileContextForJudge() so the judge can see the assembled payload.
   */
  async evaluate(
    tool: string,
    input: Record<string, unknown>,
    fileContext?: string
  ): Promise<InterceptionResult> {
    const start = Date.now();

    // --- Stage 1: Policy engine ---
    const policyResult = evaluateToolPolicy(tool, input);

    if (policyResult.decision === "allow") {
      const result: InterceptionResult = {
        allowed: true,
        tool,
        input,
        stage: "policy-allow",
        policyResult,
        similarity: null,
        judgeVerdict: null,
        evaluationMs: Date.now() - start,
        reason: policyResult.reason,
      };
      this.log(result);
      return result;
    }

    if (policyResult.decision === "deny") {
      const result: InterceptionResult = {
        allowed: false,
        tool,
        input,
        stage: "policy-deny",
        policyResult,
        similarity: null,
        judgeVerdict: null,
        evaluationMs: Date.now() - start,
        reason: policyResult.reason,
      };
      this.log(result);
      return result;
    }

    // --- Stage 2: Embedding drift check ---
    const toolDescription = this.describeToolCall(tool, input);
    const drift = await this.driftDetector.evaluate(toolDescription);

    if (drift.similarity >= this.config.reviewThreshold) {
      // High similarity to original task — allow
      const result: InterceptionResult = {
        allowed: true,
        tool,
        input,
        stage: "drift-allow",
        policyResult,
        similarity: drift.similarity,
        judgeVerdict: null,
        evaluationMs: Date.now() - start,
        reason: `Similarity ${drift.similarity.toFixed(3)} >= threshold ${this.config.reviewThreshold}`,
      };
      this.log(result);
      return result;
    }

    if (drift.similarity < this.config.denyThreshold) {
      // Very low similarity — auto-deny without judge
      const result: InterceptionResult = {
        allowed: false,
        tool,
        input,
        stage: "drift-deny",
        policyResult,
        similarity: drift.similarity,
        judgeVerdict: null,
        evaluationMs: Date.now() - start,
        reason: `Similarity ${drift.similarity.toFixed(3)} < deny threshold ${this.config.denyThreshold}`,
      };
      this.log(result);
      return result;
    }

    // --- Stage 3: LLM judge ---
    if (!this.config.enableJudge) {
      // No judge enabled — default deny for ambiguous cases
      const result: InterceptionResult = {
        allowed: false,
        tool,
        input,
        stage: "drift-deny",
        policyResult,
        similarity: drift.similarity,
        judgeVerdict: null,
        evaluationMs: Date.now() - start,
        reason: `Similarity ${drift.similarity.toFixed(3)} in review zone, judge disabled`,
      };
      this.log(result);
      return result;
    }

    const recentTools = this.toolLog.slice(-5).map(
      (r) => `${r.tool}(${this.describeToolCall(r.tool, r.input).substring(0, 80)})`
    );

    // Build the current action description, enriched with file context
    let currentAction = `${tool}(${toolDescription})`;
    if (fileContext) {
      currentAction += `\n\nFILE CONTEXT (files written during this session):\n${fileContext}`;
    }

    const judgeVerdict = await this.judge.evaluate(
      this.originalTask,
      recentTools,
      currentAction
    );

    // Only "hijacked" is denied. "consistent" and "drifting" are allowed.
    // "drifting" means the agent may be going off-task but it's not malicious —
    // the systemMessage reminder (injected at UserPromptSubmit) handles this.
    const allowed = judgeVerdict.verdict !== "hijacked";
    const result: InterceptionResult = {
      allowed,
      tool,
      input,
      stage: allowed ? "judge-allow" : "judge-deny",
      policyResult,
      similarity: drift.similarity,
      judgeVerdict,
      evaluationMs: Date.now() - start,
      reason: `Judge: ${judgeVerdict.verdict} (${judgeVerdict.reasoning})`,
    };
    this.log(result);
    return result;
  }

  /**
   * Create a text description of a tool call for embedding.
   */
  private describeToolCall(
    tool: string,
    input: Record<string, unknown>
  ): string {
    switch (tool) {
      case "Read":
        return `Read file: ${input.file_path}`;
      case "Write":
        return `Write file: ${input.file_path} with content about ${String(input.content ?? "").substring(0, 100)}`;
      case "Edit":
        return `Edit file: ${input.file_path}`;
      case "Bash":
        return `Execute command: ${String(input.command ?? "").substring(0, 200)}`;
      case "Glob":
        return `Find files matching: ${input.pattern}`;
      case "Grep":
        return `Search for: ${input.pattern}`;
      default:
        return `${tool}: ${JSON.stringify(input).substring(0, 200)}`;
    }
  }

  private log(result: InterceptionResult): void {
    this.toolLog.push(result);

    const icon =
      result.stage.endsWith("-allow") ? "✓" :
      result.stage.endsWith("-deny") ? "✗" : "?";
    const simStr = result.similarity !== null
      ? ` sim=${result.similarity.toFixed(3)}`
      : "";
    const judgeStr = result.judgeVerdict
      ? ` judge=${result.judgeVerdict.verdict}(${result.judgeVerdict.durationMs}ms)`
      : "";

    console.log(
      `    [${icon} ${result.stage}]${simStr}${judgeStr} ${result.tool}: ${result.reason} (${result.evaluationMs}ms)`
    );
  }

  getLog(): InterceptionResult[] {
    return this.toolLog;
  }

  reset(): void {
    this.toolLog = [];
    this.originalTask = "";
    this.driftDetector.reset();
  }
}
