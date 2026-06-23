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
import {
  IntentJudge,
  type JudgeVerdict,
  type JudgeBackend,
  type PromptVariant,
  type JudgePriorApproval,
} from "./intent-judge.js";
import { checkOllama, embedAny, cosineSimilarity, isBedrockModel, chat } from "./ollama-client.js";
import { checkBedrock, bedrockChat, bedrockEmbed } from "./bedrock-client.js";
import type { ImageBlock, IntentEntry, UserPermissionsLists } from "./session-tracker.js";
import { matchUserAllow, matchUserDeny } from "./user-permission-matcher.js";
import type { ApprovalRecord } from "./approval-store.js";

// Phase 8b pattern-trust thresholds. Tuned conservatively for v1; once
// telemetry shows how soft signal shifts judge verdicts these become
// env-tunable. cohere-v4 embeddings on tool-call JSON cluster tightly,
// so 0.85 is meaningful similarity, not "vaguely related."
const SOFT_THRESHOLD = 0.6;
const HARD_THRESHOLD = 0.85;
const HARD_MIN_COUNT = 2;
const JUDGE_CONTEXT_LIMIT = 5;

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
    | "approval-allow"
    | "drift-allow" | "drift-deny"
    | "judge-allow" | "judge-deny" | "judge-error"
    | "user-deny"
    | "pattern-trust-allow";
  policyResult: PolicyResult;
  /** Embedding similarity (null if not evaluated) */
  similarity: number | null;
  /** Judge verdict (null if not invoked) */
  judgeVerdict: JudgeVerdict | null;
  /** Total evaluation time in ms */
  evaluationMs: number;
  /** Reason for the decision */
  reason: string;
  /**
   * Whether the user's local Claude permission lists had something to
   * say about this call. Asymmetric semantics:
   *
   *   - { kind: "deny", rule }  — call matched a user-deny rule.
   *     ALWAYS produces stage="user-deny" and allowed=false; the early
   *     check short-circuits before Stage 1 so deny saves a judge call.
   *   - { kind: "allow", rule } — call matched a user-allow rule. Pure
   *     annotation: the verdict stands. Stage is whatever the pipeline
   *     produced (typically "policy-allow"); the dashboard renders the
   *     annotation as a side badge. User-allow NEVER weakens a deny.
   *
   * Undefined when the user has no lists, or no rule matched.
   */
  userPermissionMatch?: { kind: "allow" | "deny"; rule: string };
  /**
   * Phase 8b pattern-trust signal. When the interceptor finds prior
   * approvals in this (ownerSub, projectRoot) whose stored
   * inputEmbedding is similar to the current call:
   *
   *   - HARD mode (umbrella ON + hard ON, count of sim≥HARD_THRESHOLD
   *     ≥ HARD_MIN_COUNT): the call short-circuits to
   *     stage="pattern-trust-allow" BEFORE Stage 1 policy — overriding
   *     Dredd's hard denies (rm -rf etc). Verdict allowed=true.
   *   - SOFT mode (umbrella ON, irrespective of hard): the top matches
   *     are stitched into the judge prompt as evidence of legitimate
   *     intent. Verdict is unchanged; this field is informational so
   *     the dashboard can show "judge saw N prior approvals".
   *
   * Undefined when umbrella is off OR no matches above SOFT_THRESHOLD.
   */
  patternTrust?: {
    /** true when we short-circuited (hard); false when we only informed the judge. */
    hard: boolean;
    /** Number of matches at-or-above SOFT_THRESHOLD. */
    matched: number;
    /** Highest cosine similarity observed. */
    topSim: number;
    /** Summary of the top-matching prior approval (for the dashboard). */
    topSummary: string;
  };
  /** Set when a BYOT bearer call fell back to the platform role during
   *  this evaluation (judge path). Drives the dashboard fallback banner. */
  byotFallback?: { reason: string };
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
        const r = await bedrockChat("You are a test.", "Reply with the single word: ok", this.config.judgeModel, undefined, undefined, "preflight");
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

  async registerGoal(sessionId: string, task: string, images?: ImageBlock[], bedrockAuth?: import("./byot/types.js").BedrockAuth): Promise<void> {
    const s = this.getSession(sessionId);
    s.originalTask = task;
    s.intentImages = images?.length ? images : undefined;
    // Anything in toolLog before this point belongs to a previous goal —
    // remember the boundary so recent-history for the judge is scoped to
    // just the current task.
    s.goalStartIndex = s.toolLog.length;
    await s.driftDetector.registerGoal(task, bedrockAuth);
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
    mode: "interactive" | "autonomous" | "learn" = "autonomous",
    /** Interactive/learn intent stack at the moment of evaluation. When
     *  provided AND non-empty, the judge sees a numbered list of active
     *  goals and treats actions advancing ANY as consistent. Autonomous
     *  mode passes undefined and gets the single-goal behaviour. */
    activeIntents?: IntentEntry[],
    /** Step-6 rollout gate. When true, the judge sees rich
     *  JudgeIntentEntry[] with kind annotations (sub-task / replacement
     *  / parent pointers). When false (default legacy), the judge sees
     *  the same plain string[] it always has. Step-5 telemetry runs
     *  unchanged either way; this only affects judge prompt rendering. */
    historyActiveJudgeRendering: boolean = false,
    /** Approval-learning lookup hook. Called AFTER the policy + domain
     *  safety rails so a prior approval can never override a hard deny.
     *  Returns a summary string if a live, intent-drift-acceptable
     *  approval exists for this (scope, fingerprint), null otherwise.
     *  Caller owns scope construction, fingerprinting, and the
     *  drift-distance comparison — keeping the interceptor decoupled
     *  from the approval store. */
    approvalCheck?: () => Promise<{ summary: string } | null>,
    /** User's local Claude Code .permissions.{allow,deny,ask} snapshot,
     *  copied from the cross-session jaid-user-permissions table into
     *  session META by /intent. Asymmetric semantics — deny matches
     *  short-circuit before Stage 1 (saves a judge call), allow matches
     *  only annotate the final result. See InterceptionResult.userPermissionMatch.
     *  Undefined or null = no user policy to consult. */
    userPermissions?: UserPermissionsLists | null,
    /** Phase 8b — prior approvals for the (ownerSub, projectRoot) scope.
     *  When non-empty AND patternTrustHard is true, the interceptor
     *  embeds the current call and checks cosine similarity; ≥
     *  HARD_MIN_COUNT matches at HARD_THRESHOLD short-circuit before
     *  Stage 1 policy (overriding hard denies — by design). Soft
     *  matches (≥ SOFT_THRESHOLD) are folded into the judge prompt as
     *  context. Empty array or undefined disables both paths. */
    priorApprovals?: ApprovalRecord[],
    /** Phase 8b hard-flip. When false (default), pattern-trust runs in
     *  soft mode only: judge sees prior approvals but pipeline order is
     *  unchanged. When true, ≥ HARD_MIN_COUNT high-sim matches return
     *  pattern-trust-allow before Stage 1. */
    patternTrustHard?: boolean,
    /** Resolved Bedrock credential for this session's owner. Threaded to
     *  the judge + drift + pattern-trust embed so the user's token (when
     *  configured) bills their account. Undefined / {kind:"default"} =
     *  platform role. */
    bedrockAuth?: import("./byot/types.js").BedrockAuth,
    /** Deterministic provenance-taint evidence (provenance-taint.ts),
     *  built by the /evaluate handler from session state. Threaded to
     *  the judge as a server-trusted block. Undefined/empty → no-op. */
    taintEvidence?: string,
    /** Live working directory of this tool call (PreToolUse `cwd`), forwarded
     *  by the hook. Threaded to the policy so relative `rm` targets resolve
     *  against where the command runs. Undefined/null → projectRoot fallback. */
    cwd?: string | null,
    /** Instruction-load evidence (instruction-evidence.ts), built by the
     *  /evaluate handler from session state when DREDD_INSTRUCTIONS_EVIDENCE_ENABLED
     *  is on. Threaded to the judge as a server-trusted block. Undefined/empty → no-op. */
    instructionsEvidence?: string,
  ): Promise<InterceptionResult> {
    const start = Date.now();
    const s = this.getSession(sessionId);

    // Pre-compute the user-allow match once so we can attach it to
    // whatever verdict the pipeline ends up producing. Annotation only —
    // the pipeline's decision always stands. Computed before the user-
    // deny short-circuit so the `log` funnel can refer to it uniformly,
    // even though the deny path passes its own userPermissionMatch.
    const userAllowMatch = userPermissions?.allow?.length
      ? matchUserAllow(userPermissions.allow, tool, input)
      : null;

    // --- Stage 0: User-deny short-circuit ------------------------------
    // The user's local deny list ("Bash(curl:*)" etc) is authoritative
    // for refusal — if they've explicitly denied this pattern, we don't
    // need to run drift or the judge to confirm. Saves a judge call AND
    // gives the user-facing reason a clear cause to point at.
    //
    // CANNOT override Dredd's own dangerous-combo deny — those run in
    // Stage 1 below and never see this short-circuit (they would also
    // produce allowed=false anyway, so the layering is sound).
    if (userPermissions?.deny?.length) {
      const denyMatch = matchUserDeny(userPermissions.deny, tool, input);
      if (denyMatch.matched) {
        const result: InterceptionResult = {
          allowed: false,
          tool,
          input,
          stage: "user-deny",
          policyResult: {
            decision: "deny",
            tool,
            reason: `user deny: ${denyMatch.rule}`,
            matchedRule: denyMatch.rule,
          },
          similarity: null,
          judgeVerdict: null,
          evaluationMs: Date.now() - start,
          reason: `matches your deny list: ${denyMatch.rule}`,
          userPermissionMatch: { kind: "deny", rule: denyMatch.rule },
        };
        this.log(s, result, sessionId, userAllowMatch);
        return result;
      }
    }

    // --- Stage 0.5: Pattern-trust learning -----------------------------
    // For each prior approval in scope with a stored inputEmbedding,
    // compute cosine similarity against the current call. Above
    // SOFT_THRESHOLD the match becomes context for the judge (later
    // in the pipeline). HARD_MIN_COUNT matches at HARD_THRESHOLD
    // short-circuit to pattern-trust-allow — overrides Stage 1's hard
    // denies by design. Best-effort: embed errors silently fall through
    // to the rest of the pipeline (no pattern-trust signal that call).
    //
    // Skipped entirely when priorApprovals is empty (umbrella flag off
    // or no rows for the scope). Embed cost is one Bedrock call —
    // already in the same per-evaluate latency budget as drift.
    let softContext: JudgePriorApproval[] = [];
    if (priorApprovals && priorApprovals.length > 0) {
      const withEmbedding = priorApprovals.filter((a) => a.inputEmbedding && a.inputEmbedding.length > 0);
      if (withEmbedding.length > 0) {
        try {
          const callText = JSON.stringify({ tool, input });
          const callVecs = await embedAny(callText, this.config.embeddingModel, bedrockAuth);
          const callVec = callVecs?.[0] ?? [];
          if (callVec.length > 0) {
            const sims = withEmbedding
              .map((a) => ({ rec: a, sim: cosineSimilarity(callVec, a.inputEmbedding) }))
              .filter((m) => m.sim >= SOFT_THRESHOLD)
              .sort((x, y) => y.sim - x.sim);

            if (sims.length > 0) {
              softContext = sims.slice(0, JUDGE_CONTEXT_LIMIT).map((m) => ({
                summary: m.rec.summary,
                similarity: m.sim,
                grantedAt: m.rec.grantedAt,
                intentAtConsent: m.rec.intentSnapshot,
              }));

              // Phase 9 — the hard short-circuit counts only EXPLICIT
              // prior approvals (user clicked Allow on a Dredd-surfaced
              // ask). Tacit approvals (inferred from a Claude Code
              // native prompt + matching /notification) feed the soft
              // signal above but never override Dredd policy denies.
              // Anything missing the source field is legacy data, all
              // of which came from the explicit path.
              const strongMatches = sims.filter((m) => m.sim >= HARD_THRESHOLD);
              const strongCount = strongMatches.length;
              const strongExplicitCount = strongMatches.filter(
                (m) => (m.rec.source ?? "explicit") === "explicit",
              ).length;
              if (patternTrustHard && strongExplicitCount >= HARD_MIN_COUNT) {
                const top = sims[0];
                const result: InterceptionResult = {
                  allowed: true,
                  tool,
                  input,
                  stage: "pattern-trust-allow",
                  policyResult: {
                    decision: "allow",
                    tool,
                    reason: `pattern-trust: ${strongExplicitCount} explicit matches ≥ ${HARD_THRESHOLD}`,
                    matchedRule: "pattern-trust",
                  },
                  similarity: top.sim,
                  judgeVerdict: null,
                  evaluationMs: Date.now() - start,
                  reason:
                    `pattern-trust: ${strongExplicitCount} explicit prior approvals of similar calls ` +
                    `(top: "${top.rec.summary}", sim=${top.sim.toFixed(3)})`,
                  patternTrust: {
                    hard: true,
                    matched: sims.length,
                    topSim: top.sim,
                    topSummary: top.rec.summary,
                  },
                };
                this.log(s, result, sessionId, userAllowMatch);
                return result;
              }
            }
          }
        } catch (err) {
          // Embed call failure — log once and fall through. Pipeline
          // continues as if pattern-trust were disabled for this call.
          console.warn(
            `  [${sessionId.substring(0, 8)}] [PATTERN-TRUST] embed failed; skipping: ${(err as Error)?.message ?? err}`,
          );
        }
      }
    }

    // --- Stage 1: Policy engine ---
    const policyResult = evaluateToolPolicy(tool, input, projectRoot, cwd);

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
      this.log(s, result, sessionId, userAllowMatch);
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
      this.log(s, result, sessionId, userAllowMatch);
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
      this.log(s, result, sessionId, userAllowMatch);
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
      this.log(s, result, sessionId, userAllowMatch);
      return result;
    }
    // "review" (or no match) → check learned approvals before falling
    // through to the heuristic checks (drift + judge).

    // --- Stage 1.75: Approval lookup ---
    // Short-circuit to allow when the user has previously consented to
    // this exact (scope, fingerprint) and the session's intent hasn't
    // drifted too far from the approving moment. Skipped when no
    // approvalCheck callback is provided (e.g. autonomous mode without
    // an owner, or callers that haven't wired the store in yet).
    if (approvalCheck) {
      const approval = await approvalCheck();
      if (approval) {
        const result: InterceptionResult = {
          allowed: true,
          tool,
          input,
          stage: "approval-allow",
          policyResult,
          similarity: null,
          judgeVerdict: null,
          evaluationMs: Date.now() - start,
          reason: `Previously approved: ${approval.summary}`,
        };
        this.log(s, result, sessionId, userAllowMatch);
        return result;
      }
    }

    // --- Stage 2: Embedding drift check ---
    // If the caller passed an active intent stack (interactive/learn),
    // sync the per-session drift detector's goal embeddings so the
    // similarity check is min-distance-over-stack, not just against the
    // latest registered goal. Autonomous mode falls through to the
    // single-goal embedding registered via registerGoal().
    if (activeIntents && activeIntents.length > 0) {
      s.driftDetector.setGoalEmbeddings(activeIntents.map((e) => e.embedding));
    }

    const toolDescription = this.describeToolCall(tool, input);
    const drift = await s.driftDetector.evaluate(toolDescription, bedrockAuth);

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
      this.log(s, result, sessionId, userAllowMatch);
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
      this.log(s, result, sessionId, userAllowMatch);
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
      this.log(s, result, sessionId, userAllowMatch);
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

    // In interactive/learn mode with an active stack, pass the
    // contextual prompts of only the live (non-resolved) entries to
    // the judge so it authorises tool calls against the goals that
    // are actually still in play. Resolved entries are kept on the
    // stack for context (drift comparisons, analytics) but
    // including them in the judge's prompt drowns the current goal
    // in stale ones. If everything is resolved, fall back to the
    // freshest (last) entry — better than s.originalTask, which on
    // long-lived sessions is the turn-1 prompt and may be wildly
    // out of date. As a final fallback, use s.originalTask.
    let judgeIntent: string | string[] | import("./intent-judge.js").JudgeIntentEntry[];
    if (activeIntents && activeIntents.length > 0) {
      const liveEntries = activeIntents.filter((e) => !e.resolved);
      if (liveEntries.length > 0) {
        if (historyActiveJudgeRendering) {
          // Rich rendering: pass kind + parent pointers so the judge
          // can render sub-task / replacement / revisit annotations.
          judgeIntent = liveEntries.map((e) => ({
            id: e.id,
            contextual: e.contextual,
            kind: e.kind,
            referencedEntryId: e.referencedEntryId,
          }));
        } else {
          // Legacy rendering — plain numbered list of contextual
          // strings. Same shape the judge has always seen for the
          // interactive intent stack.
          judgeIntent = liveEntries.map((e) => e.contextual);
        }
      } else {
        // Everything resolved (Stop fired, no follow-up intent yet).
        // Use the most recent stack entry rather than s.originalTask
        // so the judge sees the user's latest goal rather than the
        // session-defining turn-1 one.
        judgeIntent = activeIntents[activeIntents.length - 1].contextual;
      }
    } else {
      judgeIntent = s.originalTask;
    }

    const judgeVerdict = await this.judge.evaluate(
      judgeIntent,
      recentTools,
      currentAction,
      s.intentImages,
      softContext.length > 0 ? softContext : undefined,
      bedrockAuth,
      taintEvidence,
      instructionsEvidence,
    );

    // Only "hijacked" is denied. "consistent" and "drifting" are allowed.
    // "drifting" means the agent may be going off-task but it's not malicious —
    // the systemMessage reminder (injected at UserPromptSubmit) handles this.
    // internalError (a code bug, not a Bedrock outage) fails CLOSED: not
    // allowed, surfaced under a distinct "judge-error" stage so the handler
    // can ask/deny with an accurate reason. verdict stays "drifting", so the
    // autonomous hijack-strike counter (gated on "hijacked") never fires.
    const allowed = judgeVerdict.verdict !== "hijacked" && !judgeVerdict.internalError;
    const result: InterceptionResult = {
      allowed,
      tool,
      input,
      stage: judgeVerdict.internalError ? "judge-error" : (allowed ? "judge-allow" : "judge-deny"),
      policyResult,
      similarity: drift.similarity,
      judgeVerdict,
      evaluationMs: Date.now() - start,
      reason: `Judge: ${judgeVerdict.verdict} (${judgeVerdict.reasoning})`,
      ...(softContext.length > 0 ? {
        patternTrust: {
          hard: false,
          matched: softContext.length,
          topSim: softContext[0].similarity,
          topSummary: softContext[0].summary,
        },
      } : {}),
      ...(judgeVerdict.byotFallback ? { byotFallback: judgeVerdict.byotFallback } : {}),
    };
    this.log(s, result, sessionId, userAllowMatch);
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

  private log(
    s: SessionGoalState,
    result: InterceptionResult,
    sessionId: string,
    /** When provided, attaches the user-allow match to the result as an
     *  informational annotation. Single funnel for every evaluate() return
     *  path so we don't have to remember the annotation step at each site. */
    userAllowMatch?: { matched: boolean; rule: string } | null,
  ): void {
    // User-allow annotation — verdict is unchanged, but the dashboard
    // wants to know the call matched the user's own allow list. When
    // the pipeline already produced a deny, append a note so the reason
    // text acknowledges the conflict ("user allows, but Dredd denies").
    // Skip when userPermissionMatch is already set (user-deny path).
    if (userAllowMatch?.matched && !result.userPermissionMatch) {
      result.userPermissionMatch = { kind: "allow", rule: userAllowMatch.rule };
      if (!result.allowed) {
        result.reason +=
          ` — note: matches your allow list (${userAllowMatch.rule}), but Dredd's checks deny`;
      }
    }

    s.toolLog.push(result);

    const icon =
      result.stage.endsWith("-allow") ? "✓" :
      result.stage.endsWith("-deny") ? "✗" : "?";
    const simStr = result.similarity !== null
      ? ` sim=${result.similarity.toFixed(3)}`
      : "";
    // Judge log includes token + cache info so we can grep CloudWatch
    // for cost outliers without dumping the full metrics snapshot.
    // Format: `judge=consistent(1886ms in=3500/cr=1700/cw=0 out=45)`
    //   cr = cacheReadInputTokens (billed at 10% of input)
    //   cw = cacheWriteInputTokens (billed at 125%; happens on first
    //        call of a 5-min cache window)
    // A missing cr field means cache miss; a missing cw means we did
    // not write either (cache disabled or below the 1024-token minimum).
    let judgeStr = "";
    if (result.judgeVerdict) {
      const j = result.judgeVerdict;
      const tokens =
        j.inputTokens !== undefined
          ? ` in=${j.inputTokens}` +
            `/cr=${j.cacheReadInputTokens ?? 0}` +
            `/cw=${j.cacheWriteInputTokens ?? 0}` +
            ` out=${j.outputTokens ?? 0}`
          : "";
      judgeStr = ` judge=${j.verdict}(${j.durationMs}ms${tokens})`;
    }
    const sessionStr = ` [${sessionId.substring(0, 8)}]`;
    const userPermStr = result.userPermissionMatch
      ? ` userPerm=${result.userPermissionMatch.kind}(${result.userPermissionMatch.rule})`
      : "";

    console.log(
      `   ${sessionStr} [${icon} ${result.stage}]${simStr}${judgeStr}${userPermStr} ${result.tool}: ${result.reason} (${result.evaluationMs}ms)`
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
