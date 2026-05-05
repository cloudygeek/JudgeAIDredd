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
import { evaluateDomainPolicy } from "./domain-policy.js";
import { DriftDetector } from "./drift-detector.js";
import { IntentJudge, type JudgeVerdict, type JudgeBackend, type PromptVariant } from "./intent-judge.js";
import { checkOllama, embedAny, isBedrockModel, chat } from "./ollama-client.js";
import { checkBedrock, bedrockChat, bedrockEmbed } from "./bedrock-client.js";
import type { ImageBlock } from "./session-tracker.js";

export interface InterceptorConfig {
  embeddingModel?: string;
  judgeModel?: string;
  /** Which backend to use for the judge LLM (default: ollama) */
  judgeBackend?: JudgeBackend;
  /** Similarity threshold below which the judge is invoked (default: 0.5) */
  reviewThreshold?: number;
  /** Similarity threshold below which the tool is auto-denied (default: 0.3) */
  denyThreshold?: number;
  /** Enable LLM judge for REVIEW decisions (default: true) */
  enableJudge?: boolean;
  /** Prompt variant: true/false for B7/standard, or "standard"/"B7"/"B7.1" */
  hardened?: boolean | PromptVariant;
  /** Reasoning effort for the LLM judge */
  judgeEffort?: "low" | "medium" | "high" | "max";
}

const DEFAULTS: Required<InterceptorConfig> = {
  embeddingModel: "eu.cohere.embed-v4:0",
  judgeModel: "nemotron-3-super",
  judgeBackend: "ollama",
  reviewThreshold: 0.6,
  denyThreshold: 0.15,
  enableJudge: true,
  hardened: false,
  judgeEffort: undefined as any,
};

export interface InterceptionResult {
  allowed: boolean;
  tool: string;
  input: Record<string, unknown>;
  /** Which stage made the decision */
  stage:
    | "policy-allow" | "policy-deny"
    | "domain-allow" | "domain-deny"
    | "drift-allow" | "drift-deny"
    | "judge-allow" | "judge-deny";
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

/**
 * Per-session goal state. One instance per `session_id` so concurrent users
 * of the same judge process do not stomp on each other's intent. Before
 * this was introduced the interceptor held a single `originalTask` field —
 * whichever session last called `registerGoal` would silently overwrite
 * every other session's anchor, and tool calls from session B would be
 * judged against session A's goal.
 */
interface SessionGoalState {
  originalTask: string;
  intentImages: ImageBlock[] | undefined;
  driftDetector: DriftDetector;
  toolLog: InterceptionResult[];
  /** Index into toolLog marking where the current goal started. Tool calls
   *  before this index belong to previous (completed) goals and must not
   *  be fed to the judge — otherwise stale actions from earlier turns get
   *  interpreted as "trajectory" for the current task. */
  goalStartIndex: number;
}

export class PreToolInterceptor {
  private config: Required<InterceptorConfig>;
  private judge: IntentJudge;
  private sessions = new Map<string, SessionGoalState>();

  constructor(config?: InterceptorConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.judge = new IntentJudge(this.config.judgeModel, this.config.judgeBackend, this.config.judgeEffort, this.config.hardened);
  }

  private getSession(sessionId: string): SessionGoalState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        originalTask: "",
        intentImages: undefined,
        driftDetector: new DriftDetector(this.config.embeddingModel),
        toolLog: [],
        goalStartIndex: 0,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  async preflight(): Promise<void> {
    const usingBedrockEmbed = isBedrockModel(this.config.embeddingModel);
    const usingBedrockJudge = this.config.judgeBackend === "bedrock";

    // Check Ollama only for whichever components actually use it
    if (!usingBedrockEmbed || !usingBedrockJudge) {
      const ollamaModels = [
        ...(!usingBedrockEmbed ? [this.config.embeddingModel] : []),
        ...(!usingBedrockJudge ? [this.config.judgeModel] : []),
      ];
      const { ok, missing } = await checkOllama(ollamaModels[0], ollamaModels[1]);
      if (!ok) {
        console.error(`Missing Ollama models: ${missing.join(", ")}`);
        for (const m of missing) console.error(`  ollama pull ${m}`);
        throw new Error(`Missing Ollama models: ${missing.join(", ")}`);
      }
    }

    // Check Bedrock for whichever components use it
    if (usingBedrockJudge) {
      const bedrockOk = await checkBedrock(this.config.judgeModel);
      if (!bedrockOk) {
        throw new Error(
          `Bedrock judge model ${this.config.judgeModel} not accessible. ` +
          `Check AWS credentials and that the model is enabled.`
        );
      }
    }

    // Live embedding test
    const embedStart = Date.now();
    try {
      const vecs = await embedAny("preflight connectivity test", this.config.embeddingModel);
      if (!vecs?.[0]?.length) throw new Error("empty embedding response");
      console.log(
        `  ✓ Embedding model OK (${this.config.embeddingModel}, ` +
        `dim=${vecs[0].length}, ${Date.now() - embedStart}ms)`
      );
    } catch (err) {
      throw new Error(
        `Embedding model ${this.config.embeddingModel} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const judgeStart = Date.now();
    try {
      if (this.config.judgeBackend === "bedrock") {
        const r = await bedrockChat("You are a test.", "Reply with the single word: ok", this.config.judgeModel);
        if (!r.content) throw new Error("empty response");
      } else {
        const r = await chat(
          [{ role: "user", content: "Reply with the single word: ok" }],
          this.config.judgeModel
        );
        if (!r.content) throw new Error("empty response");
      }
      console.log(
        `  ✓ Judge model OK (${this.config.judgeBackend}/${this.config.judgeModel}, ` +
        `${Date.now() - judgeStart}ms)`
      );
    } catch (err) {
      throw new Error(
        `Judge model ${this.config.judgeModel} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async registerGoal(sessionId: string, task: string, images?: ImageBlock[]): Promise<void> {
    const s = this.getSession(sessionId);
    s.originalTask = task;
    s.intentImages = images?.length ? images : undefined;
    // Anything in toolLog before this point belongs to a previous goal —
    // remember the boundary so recent-history for the judge is scoped to
    // just the current task.
    s.goalStartIndex = s.toolLog.length;
    await s.driftDetector.registerGoal(task);
  }

  getCurrentGoal(sessionId: string): string {
    return this.sessions.get(sessionId)?.originalTask ?? "";
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
    sessionId: string,
    tool: string,
    input: Record<string, unknown>,
    fileContext?: string,
    projectRoot?: string | null,
    /** Trust mode for THIS call. Defaults to "autonomous" so existing
     *  callers that don't pass it keep the strict pipeline. Interactive
     *  mode skips the drift-deny short-circuit and escalates everything
     *  ambiguous to the judge — short user replies generate
     *  low-information embeddings that produce false drift-deny signals
     *  the judge handles correctly with the full goal context. */
    mode: "interactive" | "autonomous" | "learn" = "autonomous"
  ): Promise<InterceptionResult> {
    const start = Date.now();
    const s = this.getSession(sessionId);

    // --- Stage 1: Policy engine ---
    const policyResult = evaluateToolPolicy(tool, input, projectRoot);

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
      this.log(s, result, sessionId);
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
      this.log(s, result, sessionId);
      return result;
    }

    // --- Stage 1.5: Domain policy (R1–R7) ---
    // Structural / compositional rules that know the session intent and
    // the prior tool calls in the current turn. Can short-circuit with
    // "allow" (clearly legitimate, skip the judge) or "deny" (clearly
    // malicious composition). "review" falls through to drift + judge.
    const priorTurnCalls = s.toolLog.slice(s.goalStartIndex).map((r) => ({
      tool: r.tool,
      input: r.input,
      allowed: r.allowed,
    }));
    const domainResult = evaluateDomainPolicy(tool, input, {
      originalTask: s.originalTask,
      priorTurnCalls,
    });

    if (domainResult?.decision === "deny") {
      const result: InterceptionResult = {
        allowed: false,
        tool,
        input,
        stage: "domain-deny",
        policyResult,
        similarity: null,
        judgeVerdict: null,
        evaluationMs: Date.now() - start,
        reason: `${domainResult.matchedRule}: ${domainResult.reason}`,
      };
      this.log(s, result, sessionId);
      return result;
    }

    if (domainResult?.decision === "allow") {
      const result: InterceptionResult = {
        allowed: true,
        tool,
        input,
        stage: "domain-allow",
        policyResult,
        similarity: null,
        judgeVerdict: null,
        evaluationMs: Date.now() - start,
        reason: `${domainResult.matchedRule}: ${domainResult.reason}`,
      };
      this.log(s, result, sessionId);
      return result;
    }
    // "review" (or no match) → continue to drift + judge.

    // --- Stage 2: Embedding drift check ---
    const toolDescription = this.describeToolCall(tool, input);
    const drift = await s.driftDetector.evaluate(toolDescription);

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
      this.log(s, result, sessionId);
      return result;
    }

    if (drift.similarity < this.config.denyThreshold && mode !== "interactive") {
      // Very low similarity — auto-deny without judge.
      //
      // SKIPPED in interactive mode. The user is steering and the goal
      // updates each turn from short replies ("option 2", "do that one",
      // "fix it"). Those short prompts produce low-information embeddings
      // that have low cosine similarity to ANY tool call, so a hard deny
      // here false-positives. Escalate to the judge instead — it sees the
      // full prior turn and can decide. In autonomous mode the goal is
      // the original intent, the embedding is rich, and drift-deny is
      // a meaningful security signal — keep it.
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
      this.log(s, result, sessionId);
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
      this.log(s, result, sessionId);
      return result;
    }

    // Only consider tool calls taken since the current goal was registered.
    // Earlier calls belong to a previous (completed) user task and would
    // mislead the judge into thinking the agent has drifted.
    const currentGoalTools = s.toolLog.slice(s.goalStartIndex);
    const recentTools = currentGoalTools.slice(-5).map(
      (r) => `${r.tool}(${this.describeToolCall(r.tool, r.input).substring(0, 80)})`
    );

    // Build the current action description, enriched with file context
    let currentAction = `${tool}(${toolDescription})`;
    if (fileContext) {
      currentAction += `\n\nFILE CONTEXT (files written during this session):\n${fileContext}`;
    }

    const judgeVerdict = await this.judge.evaluate(
      s.originalTask,
      recentTools,
      currentAction,
      s.intentImages
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
    this.log(s, result, sessionId);
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

  private log(s: SessionGoalState, result: InterceptionResult, sessionId: string): void {
    s.toolLog.push(result);

    const icon =
      result.stage.endsWith("-allow") ? "✓" :
      result.stage.endsWith("-deny") ? "✗" : "?";
    const simStr = result.similarity !== null
      ? ` sim=${result.similarity.toFixed(3)}`
      : "";
    const judgeStr = result.judgeVerdict
      ? ` judge=${result.judgeVerdict.verdict}(${result.judgeVerdict.durationMs}ms)`
      : "";
    const sessionStr = ` [${sessionId.substring(0, 8)}]`;

    console.log(
      `   ${sessionStr} [${icon} ${result.stage}]${simStr}${judgeStr} ${result.tool}: ${result.reason} (${result.evaluationMs}ms)`
    );
  }

  getLog(sessionId: string): InterceptionResult[] {
    return this.sessions.get(sessionId)?.toolLog ?? [];
  }

  /** Clear per-session goal + log. Called on /end (session finished) and
   *  /pivot (user changed direction — next registerGoal will set fresh
   *  state). Does NOT affect other sessions. */
  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
