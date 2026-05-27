/**
 * POST /evaluate — PreToolUse decision handler.
 *
 * The hot path. Runs the three-stage pipeline (policy → drift → judge)
 * via `interceptor.evaluate`, applies the trust-mode policy (autonomous
 * deny, interactive ask, learn shadow), and consults the approval
 * store to short-circuit previously-consented (scope, fingerprint)
 * matches before the judge runs.
 *
 * Extracted from server-hook.ts.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  tracker,
  interceptor,
  approvals,
  registeredSessions,
  addFeed,
  readBody,
  json,
  BODY_LIMIT_TRANSCRIPT,
  rejectInvalidSessionId,
  authenticateHookRequest,
  authStageForFeed,
  backfillFromTranscript,
  backfillFromSummary,
  CONFIG,
  USER_PERMISSIONS_ENFORCED,
  PATTERN_LEARNING_ENABLED,
  PATTERN_LEARNING_HARD,
  PROVENANCE_TAINT_ENABLED,
  CREDENTIAL_CONSENT_ENABLED,
  credentialProvider,
  byotStore,
  type TrustMode,
} from "../server-core.js";
import {
  setPendingClassification,
  awaitPendingClassification,
} from "../intent-classifier.js";
import {
  computeApprovalFingerprint,
} from "../approval-fingerprint.js";
import {
  recordPendingApproval,
} from "../pending-approvals.js";
import { APPROVAL_INTENT_DRIFT_THRESHOLD } from "../approval-store.js";
import { cosineSimilarity } from "../ollama-client.js";
import { buildTaintEvidence } from "../provenance-taint.js";
import {
  effectiveMode,
  effectiveIntentHistoryMode,
  intentClassifier,
  INTENT_CLASSIFIER_LLM_ENABLED,
  CLASSIFIER_EVALUATE_WAIT_MS,
  DREDD_TAG,
} from "./_shared.js";

// =========================================================================
// BYOT runtime-fallback recording (throttled, module-scope)
// =========================================================================
const BYOT_FALLBACK_THROTTLE_MS = 5 * 60 * 1000;
// Unbounded by design: one entry per ownerSub that ever fell back, bounded
// by the number of distinct users with broken tokens — no eviction needed
// at current scale.
const lastByotFallbackAt = new Map<string, number>();
async function recordByotFallbackThrottled(ownerSub: string, reason: string): Promise<void> {
  const now = Date.now();
  const last = lastByotFallbackAt.get(ownerSub) ?? 0;
  if (now - last < BYOT_FALLBACK_THROTTLE_MS) return;
  lastByotFallbackAt.set(ownerSub, now);
  try {
    await byotStore.markRuntimeFallback(ownerSub, reason, new Date().toISOString());
  } catch (err) {
    console.warn(`[byot] markRuntimeFallback failed for ${ownerSub.substring(0, 8)}: ${(err as Error)?.message ?? err}`);
  }
}

// =========================================================================
// POST /evaluate — PreToolUse
// =========================================================================
const LOCKED_MESSAGE =
  "this session has been classified as hijacked and further tool calls will not be allowed.";

async function handleEvaluate(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req, BODY_LIMIT_TRANSCRIPT));

  const isBenchmarkFormat = body.proposed_action && body.session;
  const session_id: string = isBenchmarkFormat ? body.session : body.session_id;
  const tool_name: string = isBenchmarkFormat ? body.proposed_action.tool : body.tool_name;
  const tool_input: Record<string, unknown> = isBenchmarkFormat ? (body.proposed_action.parameters ?? {}) : body.tool_input;
  // Per-call id Claude Code sends in PreToolUse and re-sends in
  // PostToolUse. Lets us correlate /evaluate decisions with /track
  // outcomes for the same call. Optional — benchmark harnesses don't
  // emit one, in which case the row carries null.
  const tool_use_id: string | null =
    typeof body.tool_use_id === "string" && body.tool_use_id.length > 0
      ? body.tool_use_id
      : null;
  const { agent_reasoning, transcript_path } = body;
  const transcriptContent: string | undefined = body.transcript_content;
  const transcriptSummary: unknown = body.transcript_summary;
  const mode: TrustMode = effectiveMode(session_id, body.mode);
  const isLearn = mode === "learn";

  if (rejectInvalidSessionId(res, session_id)) return;
  if (!tool_name) {
    return json(res, 400, { error: "Missing tool_name" });
  }

  // Mark the turn-state — the agent has fired a PreToolUse, so any
  // UserPromptSubmit between now and the next Stop is queued (DRAINING).
  // Best-effort: we don't fail the request on a marker write error.
  await tracker.notePreToolUse(session_id).catch((err) => {
    console.warn(`  [${session_id.substring(0, 8)}] notePreToolUse failed: ${err}`);
  });

  if (!registeredSessions.has(session_id)) {
    // Resolve the caller's BYOT credential for the rehydration/backfill
    // goal embeds below so they bill the user's account too (the main
    // /evaluate path resolves separately from ownerForApproval). Fails
    // soft to {kind:"default"} when BYOT is off — byte-identical then.
    const backfillAuth = await credentialProvider.resolve(identity.ownerSub);
    // Rehydrate from the SessionStore before falling back to transcript
    // backfill. registeredSessions is per-process in-memory, so any
    // container restart (or a fresh deployment) loses the Set even
    // though the underlying SessionStore still has originalIntent +
    // history persisted. Without this, every /evaluate after a hook
    // redeploy lands in no-goal-allow despite the session being
    // registered as far as Dynamo is concerned. (2026-05-12 incident.)
    //
    // Use the LIVE active set, not the literal originalIntent. On a
    // long-running session the originalIntent is the turn-1 prompt,
    // potentially weeks old and topic-irrelevant. The active set is
    // what the classifier last decided was current. Falling back to
    // originalIntent only when no active entries are persisted —
    // covers the legacy-schema migration path. (2026-05-12 #2: session
    // anchored on stale "review markdown" goal because rehydration
    // ignored the live stack.)
    const persisted = await tracker.loadSession(session_id);
    const persistedActive = await tracker.getActiveIntents(session_id);
    if (persistedActive.length > 0) {
      // Live active set found in Dynamo. The interceptor's drift
      // detector reads goal embeddings from the live stack via
      // setGoalEmbeddings (already done by the SessionStore on the
      // fetch path). Register the most recent active entry's goal
      // with the interceptor as a fallback for autonomous mode; the
      // interactive path will pull the full activeIntents list on
      // /evaluate via getActiveIntents below.
      const freshest = persistedActive[persistedActive.length - 1];
      await interceptor.registerGoal(session_id, freshest.contextual, undefined, backfillAuth);
      registeredSessions.add(session_id);
      console.log(
        `  [${session_id.substring(0, 8)}] [REHYDRATE] restored ${persistedActive.length} active intent(s); freshest: "${freshest.prompt.substring(0, 60)}..."`,
      );
    } else if (persisted?.originalIntent) {
      // No active entries (legacy session pre-history-active migration,
      // or a session whose stack was wiped via /api/mode flip). Fall
      // back to the persisted originalIntent — better than nothing,
      // but flag that we're using a stale anchor so the operator can
      // see it in the logs.
      const contextual = persisted.originalIntent.prompt;
      await interceptor.registerGoal(session_id, contextual, undefined, backfillAuth);
      registeredSessions.add(session_id);
      const ageMin = Math.round((Date.now() - new Date(persisted.originalIntent.timestamp).getTime()) / 60000);
      console.log(
        `  [${session_id.substring(0, 8)}] [REHYDRATE] no active set; falling back to originalIntent (${ageMin}m old): "${contextual.substring(0, 60)}..."`,
      );
    } else {
      // Cold path: nothing in Dynamo and no in-memory state. Try
      // the structured summary first; fall back to raw JSONL.
      const usedSummary = transcriptSummary
        ? await backfillFromSummary(session_id, transcriptSummary)
        : false;
      if (!usedSummary) {
        if (transcriptContent) {
          await backfillFromTranscript(session_id, transcriptContent, true);
        } else if (transcript_path) {
          await backfillFromTranscript(session_id, transcript_path);
        }
      }
    }

    if (!registeredSessions.has(session_id)) {
      const projectRoot = await tracker.getProjectRoot(session_id);
      const policyOnly = (await import("../tool-policy.js")).evaluateToolPolicy(tool_name, tool_input ?? {}, projectRoot);
      const noGoalDetail = transcriptContent
        ? "backfill from transcript content failed"
        : transcript_path
          ? "backfill from transcript file failed"
          : "no transcript provided";
      if (policyOnly.decision === "deny" && !isLearn) {
        // Interactive mode surfaces as "ask" (user adjudicates),
        // autonomous mode hard-denies. Same advisory-vs-enforcing
        // split as the main /evaluate path below.
        const decision = mode === "interactive" ? "ask" : "deny";
        const reason = mode === "interactive"
          ? `${DREDD_TAG} (no goal yet, ${noGoalDetail}): policy flagged this as ${policyOnly.reason}. Approve only if this matches your intent.`
          : `${DREDD_TAG} (no goal, ${noGoalDetail}): ${policyOnly.reason}`;
        return json(res, 200, {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: reason,
          },
          _meta: { allowed: false, stage: "policy-deny", reason: policyOnly.reason, noGoalDetail },
        });
      }
      return json(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `${DREDD_TAG}: no goal registered (${noGoalDetail}), policy allows`,
        },
        _meta: { allowed: true, stage: "no-goal-allow", reason: "No goal registered, policy allows", noGoalDetail },
      });
    }
  }

  if (mode === "autonomous" && (await tracker.isLocked(session_id))) {
    await tracker.recordToolCall(session_id, tool_name, tool_input ?? {}, "deny", null, tool_use_id);
    addFeed({
      timestamp: new Date().toISOString(),
      type: "tool",
      tool: tool_name,
      stage: "session-locked",
      allowed: false,
      reason: LOCKED_MESSAGE,
      sessionId: session_id,
      ownerSub: identity.ownerSub,
      authStage: authStageForFeed(identity),
    });
    if (isBenchmarkFormat) {
      return json(res, 200, {
        verdict: "hijacked",
        confidence: 1.0,
        rationale: LOCKED_MESSAGE,
      });
    }
    return json(res, 200, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${DREDD_TAG}: ${LOCKED_MESSAGE}`,
      },
      systemMessage: LOCKED_MESSAGE,
      _meta: {
        allowed: false,
        stage: "session-locked",
        reason: LOCKED_MESSAGE,
        hijackStrikes: await tracker.getHijackStrikes(session_id),
        locked: true,
      },
    });
  }

  let fileContext: string | undefined;
  if (tool_name === "Bash") {
    const command = String(tool_input?.command ?? "");
    const writtenFiles = await tracker.getWrittenFiles(session_id);

    const referencesWritten = writtenFiles.some((f) =>
      command.includes(f.path) || command.includes(f.path.split("/").pop()!)
    );

    if (referencesWritten || /git\s+(add|commit|push)/.test(command)) {
      fileContext = await tracker.getFileContextForJudge(session_id);
    }
  }

  let fullContext = fileContext ?? "";
  if (agent_reasoning) {
    fullContext = (fullContext ? fullContext + "\n\n" : "") +
      `AGENT REASONING (why it wants to use this tool):\n${agent_reasoning}`;
  }

  // If an async LLM intent classifier is in flight for this session
  // (kicked off by the most recent /intent), wait briefly for its
  // verdict so a fast override can correct the active set BEFORE we
  // judge this tool call. Cap the wait so a slow Bedrock doesn't
  // hold up tool execution. Best-effort — on timeout the existing
  // (embedding-fallback) active set stays in place.
  //
  // Gated by INTENT_CLASSIFIER_LLM_ENABLED so when the LLM path is
  // off no /intent ever calls setPendingClassification, the map is
  // always empty, and we skip the await entirely instead of hitting
  // the 750ms timeout false-negative.
  if (
    INTENT_CLASSIFIER_LLM_ENABLED &&
    (mode === "interactive" || mode === "learn")
  ) {
    await awaitPendingClassification(session_id, CLASSIFIER_EVALUATE_WAIT_MS);
  }

  // In interactive/learn mode pass the active intent stack so the judge
  // authorises against ALL queued goals, not just the most recent. In
  // autonomous mode pass undefined and keep the single-goal behaviour.
  const activeIntents =
    mode === "interactive" || mode === "learn"
      ? await tracker.getActiveIntents(session_id)
      : undefined;

  // Touch every materialised active entry so its lastActiveAt is bumped.
  // Drives LRU eviction of the active set in the history-active model:
  // entries that haven't been referenced by a recent /evaluate stay
  // older than entries currently being judged against and get evicted
  // first when the active set overflows. Best-effort — don't fail
  // /evaluate on a Dynamo write hiccup.
  if (activeIntents && activeIntents.length > 0) {
    Promise.all(
      activeIntents
        .filter((e) => e.id)
        .map((e) => tracker.touchActiveIntent(session_id, e.id!).catch(() => {})),
    ).catch(() => {});
  }

  // Approval-learning lookup: built once here so the interceptor only
  // has to invoke a closure. Conditions for any lookup:
  //   - we can compute a fingerprint for this tool call,
  //   - the session has a known owner + projectRoot (no approvals
  //     persisted for anonymous or rootless sessions),
  //   - we have a current intent embedding to compare against the
  //     snapshot (the intent-drift backstop).
  // When any precondition fails, the callback resolves to null and the
  // interceptor falls through to the heuristic checks.
  const projectRootForApproval = await tracker.getProjectRoot(session_id);
  const ownerForApproval = await tracker.getSessionOwner(session_id);
  const approvalCheck = async (): Promise<{ summary: string } | null> => {
    if (!projectRootForApproval || !ownerForApproval.ownerSub) return null;
    if (mode !== "interactive") return null; // only the consent mode uses approvals
    const fp = computeApprovalFingerprint(tool_name, tool_input ?? {}, {
      credentialConsent: CREDENTIAL_CONSENT_ENABLED,
    });
    if (!fp) return null;
    const scope = {
      ownerSub: ownerForApproval.ownerSub,
      projectRoot: projectRootForApproval,
    };
    const record = await approvals.lookup(scope, fp.hash);
    if (!record) return null;

    // Intent-drift backstop: snapshot was taken when the user
    // consented; reject the approval if the session's current intent
    // has drifted too far from that moment. Cosine distance > 0.4 ≈
    // semantically different goal — re-prompt the user.
    //
    // SKIPPED for exact credential→host pairs: the (credential-source,
    // exact-host) pair IS the consent boundary the user accepted, and
    // terse follow-up turns ("go", "do b") embed far from the original
    // consent intent — so the drift check would re-ask on nearly every
    // follow-up and defeat the feature. A hijack would target a
    // DIFFERENT host → a different pair → re-ask anyway.
    if (!fp.isCredentialPair) {
      const currentEmbedding =
        activeIntents && activeIntents.length > 0
          ? activeIntents[activeIntents.length - 1].embedding
          : null;
      if (
        currentEmbedding &&
        currentEmbedding.length > 0 &&
        record.goalEmbedding.length > 0
      ) {
        const sim = cosineSimilarity(currentEmbedding, record.goalEmbedding);
        const distance = 1 - sim;
        if (distance > APPROVAL_INTENT_DRIFT_THRESHOLD) {
          console.log(
            `  [${session_id.substring(0, 8)}] [APPRV] match for "${record.summary}" rejected — intent drift ${distance.toFixed(3)} > ${APPROVAL_INTENT_DRIFT_THRESHOLD}`,
          );
          return null;
        }
      }
    }

    // Fire-and-forget touch: keeps the TTL fresh on every hit.
    approvals.touchLastUsed(scope, fp.hash).catch(() => {});
    return { summary: record.summary };
  };

  // Pull the user's local Claude allow/deny/ask snapshot from session
  // META (copied in by /intent at session start). When non-null the
  // interceptor's Stage 0 short-circuits on user-deny matches and
  // annotates user-allow matches into result.userPermissionMatch.
  //
  // Gated on the Phase 6 rollout flag — when disabled, the snapshot
  // still exists in session META (for dashboard surfacing) but the
  // pipeline ignores it. Lets us deploy the upload + storage path
  // first and only flip enforcement once we've observed clean traffic.
  const userPermissionsForEval = USER_PERMISSIONS_ENFORCED
    ? await tracker.getUserPermissions(session_id)
    : null;

  // Phase 8b — fetch prior approvals for the (ownerSub, projectRoot)
  // scope so the interceptor can run pattern-trust. Skipped entirely
  // when the umbrella is off or the call has no owner+projectRoot
  // (anonymous or rootless session).
  let priorApprovalsForEval: import("../approval-store.js").ApprovalRecord[] = [];
  if (
    PATTERN_LEARNING_ENABLED &&
    ownerForApproval.ownerSub &&
    projectRootForApproval
  ) {
    try {
      priorApprovalsForEval = await approvals.listForScope(
        { ownerSub: ownerForApproval.ownerSub, projectRoot: projectRootForApproval },
        200,
      );
    } catch (err) {
      console.warn(
        `  [${session_id.substring(0, 8)}] [PATTRN] listForScope failed; skipping: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  // Resolve the session owner's BYOT credential (cached; {kind:"default"}
  // when BYOT is off or the user has no token configured).
  const bedrockAuth = await credentialProvider.resolve(ownerForApproval.ownerSub);

  // Provenance-taint evidence (long-horizon judge augmentation). Derived
  // purely from already-tracked session state — no extra Bedrock or
  // Dynamo round-trip beyond the getters below (cheap; the cached store
  // serves them from the warm in-container snapshot). Strictly fail-soft:
  // any error leaves taintEvidence undefined and the judge runs as today.
  let taintEvidence: string | undefined;
  if (PROVENANCE_TAINT_ENABLED) {
    try {
      const [filesRead, filesWritten, envVars] = await Promise.all([
        tracker.getFilesRead(session_id),
        tracker.getWrittenFiles(session_id),
        tracker.getEnvVars(session_id),
      ]);
      const ev = buildTaintEvidence({
        tool: tool_name,
        input: tool_input ?? {},
        filesRead,
        filesWritten,
        envVars,
      });
      if (ev.chains.length > 0) {
        taintEvidence = ev.text;
        console.log(
          `  [${session_id.substring(0, 8)}] [TAINT] ${ev.chains.length} chain(s); ` +
            `top: ${ev.chains[0].description.substring(0, 120)}`,
        );
      }
    } catch (err) {
      console.warn(
        `  [${session_id.substring(0, 8)}] [TAINT] analysis failed; skipping: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  const result = await interceptor.evaluate(
    session_id,
    tool_name,
    tool_input ?? {},
    fullContext || undefined,
    projectRootForApproval,
    mode,
    activeIntents,
    effectiveIntentHistoryMode(session_id),
    approvalCheck,
    userPermissionsForEval,
    priorApprovalsForEval,
    PATTERN_LEARNING_HARD,
    bedrockAuth,
    taintEvidence,
  );

  // Spec §7: surface BYOT runtime failures on the config record so the
  // dashboard can warn the user. Throttled in-memory to once / 5 min per
  // owner to avoid hammering Dynamo when a token stays broken.
  if (result.byotFallback && ownerForApproval.ownerSub) {
    void recordByotFallbackThrottled(ownerForApproval.ownerSub, result.byotFallback.reason);
  }

  await tracker.recordToolCall(
    session_id,
    tool_name,
    tool_input ?? {},
    result.allowed ? "allow" : "deny",
    result.similarity,
    tool_use_id,
    {
      stage: result.stage,
      reason: result.reason,
      judgeVerdict: result.judgeVerdict,
      userPermissionMatch: result.userPermissionMatch,
      patternTrust: result.patternTrust,
    },
  );

  let lockState: { strikes: number; locked: boolean; justLocked: boolean } | null = null;
  if (
    mode === "autonomous" &&
    !result.allowed &&
    result.judgeVerdict?.verdict === "hijacked"
  ) {
    lockState = await tracker.recordHijackStrike(session_id, CONFIG.hijackThreshold);
    if (lockState.justLocked) {
      console.warn(
        `  [${session_id.substring(0, 8)}] [LOCK] Hijack threshold reached ` +
        `(${lockState.strikes}/${CONFIG.hijackThreshold}) — session locked; ` +
        `all further tool calls will be denied`
      );
    } else {
      console.warn(
        `  [${session_id.substring(0, 8)}] [STRIKE] Hijack strike ${lockState.strikes}/${CONFIG.hijackThreshold}`
      );
    }
  }

  addFeed({
    timestamp: new Date().toISOString(),
    type: "tool",
    tool: tool_name,
    stage: isLearn ? `${result.stage} (learn-shadow)` : result.stage,
    allowed: result.allowed,
    reason: result.reason.substring(0, 500),
    sessionId: session_id,
    ownerSub: identity.ownerSub,
    authStage: authStageForFeed(identity),
    userPermission: result.userPermissionMatch,
    patternTrust: result.patternTrust,
  });

  if (isLearn && !result.allowed) {
    console.log(
      `  [${session_id.substring(0, 8)}] [LEARN] Would have blocked ${tool_name}: ${result.reason} — passing through to user permissions`
    );
  }

  const hookResponse: Record<string, unknown> = {};

  if (isLearn) {
    // Shadow mode — no decision. Claude Code uses user permissions config.
  } else if (!result.allowed) {
    // Decision shape varies by trust mode:
    //
    //   autonomous → permissionDecision: "deny" — Dredd unilaterally
    //     blocks. The agent has no human in the loop, so a verdict
    //     of "this is suspicious" must be enforced.
    //
    //   interactive → permissionDecision: "ask" — surface the verdict
    //     to the user as a permission dialog with Dredd's reasoning.
    //     The user adjudicates: allow once / always / block. This
    //     respects the "human in the loop" contract of interactive
    //     mode — Dredd warns, the user decides. (Per contribution-3
    //     of the Springer revision: interactive mode is advisory,
    //     autonomous is enforcing.)
    //
    //   The session-locked path (justLocked) still hard-denies
    //   because that's the catastrophic case — N consecutive judge
    //   hijack verdicts means we no longer trust this session at all.
    //   In interactive mode the user could still flip the
    //   per-session mode to learn or autonomous via the dashboard.
    if (lockState?.justLocked) {
      hookResponse.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${DREDD_TAG}: ${LOCKED_MESSAGE}`,
      };
      hookResponse.systemMessage = LOCKED_MESSAGE;
    } else if (result.stage === "user-deny") {
      // User-deny is authoritative — the user has explicitly listed this
      // pattern in their .permissions.deny. Even in interactive mode we
      // hard-deny rather than re-asking, since they've already made
      // their preference clear. Surfaced as deny so Claude Code drops
      // the call without re-prompting.
      hookResponse.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `${DREDD_TAG}: ${result.reason}` +
          ` — blocked by your local Claude Code deny list.`,
      };
    } else if (mode === "interactive") {
      // Surface as an "ask" — Claude Code shows the user a
      // permission prompt with our reason. The reason text is
      // user-facing, so phrase it accordingly: lead with the
      // suspicion, end with what to check.
      //
      // Approval-learning: stash a pending candidate keyed by the
      // tool_use_id so the matching PostToolUse can promote it to a
      // durable approval. If the user denies the prompt, no PostToolUse
      // arrives and the candidate expires after 60s — we never learn
      // from a denied prompt.
      const fp = computeApprovalFingerprint(tool_name, tool_input ?? {}, {
        credentialConsent: CREDENTIAL_CONSENT_ENABLED,
      });
      let learningNote = "";
      if (fp && tool_use_id) {
        // Snapshot the freshest active-intent embedding as the
        // intent-drift backstop anchor. Lookup compares the session's
        // intent embedding at THAT moment against this snapshot;
        // a >0.4 cosine distance rejects the approval even if the
        // fingerprint matches.
        const freshest = activeIntents && activeIntents.length > 0
          ? activeIntents[activeIntents.length - 1]
          : null;
        const intentSnapshot = freshest?.prompt ?? "";
        const goalEmbedding = freshest?.embedding ?? [];
        recordPendingApproval(session_id, tool_use_id, {
          tool: tool_name,
          fingerprintHash: fp.hash,
          fingerprintJson: fp.fingerprintJson,
          summary: fp.summary,
          intentSnapshot,
          goalEmbedding,
        });
        // Tell the user what will be remembered if they accept. Keeps
        // consent explicit — they're not just allowing this call,
        // they're allowing every future call with the same shape from
        // this project for 30 days.
        learningNote =
          ` Approving will remember: ${fp.summary} from this project, ` +
          `for 30 days. Revoke any time from the dashboard's Approvals tab.`;
      }

      const askReason =
        `${DREDD_TAG}: this tool call looks suspicious. ${result.reason}. ` +
        `Review and approve only if this matches your intent.${learningNote}`;
      hookResponse.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: askReason,
      };
    } else {
      // Autonomous (or any other non-interactive non-learn mode):
      // hard-deny with a system message the agent can read.
      const currentGoal = interceptor.getCurrentGoal(session_id)
        || (await tracker.getSessionContext(session_id)).originalTask
        || "unknown";
      const userVisibleGoal = currentGoal.includes("USER PROMPT:\n")
        ? currentGoal.split("USER PROMPT:\n").pop()!.trim()
        : currentGoal;
      hookResponse.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${DREDD_TAG}: ${result.reason}`,
      };
      hookResponse.systemMessage =
        `[SECURITY] Tool call ${tool_name} was blocked. Reason: ${result.reason}. ` +
        `Stay focused on the current task: "${userVisibleGoal}".`;
    }
  } else {
    hookResponse.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `${DREDD_TAG}: ${result.reason}`,
    };

    // Phase 9 — tacit-pending stash. Dredd is fine with this call, but
    // Claude Code may still surface a native permission prompt because
    // it's not in the user's local allowlist. If that prompt fires and
    // the user clicks Yes, we want to learn the consent for next time.
    //
    // Stashing here is cheap: we just hold the fingerprint in memory
    // until /track arrives. The actual promotion in /track gates on a
    // matching /notification arriving in the window — if no prompt
    // fires (Claude Code auto-allowed), the candidate is silently
    // dropped without producing an approval record.
    //
    // Gated to interactive mode + non-pattern-trust stages: in
    // autonomous mode Claude Code's native prompt path is rarely the
    // friction we're trying to capture, and a pattern-trust-allow has
    // already inherited consent from a prior explicit approval.
    if (
      mode === "interactive" &&
      tool_use_id &&
      result.stage !== "pattern-trust-allow" &&
      result.stage !== "approval-allow"
    ) {
      const fp = computeApprovalFingerprint(tool_name, tool_input ?? {}, {
        credentialConsent: CREDENTIAL_CONSENT_ENABLED,
      });
      if (fp) {
        const freshest = activeIntents && activeIntents.length > 0
          ? activeIntents[activeIntents.length - 1]
          : null;
        recordPendingApproval(session_id, tool_use_id, {
          tool: tool_name,
          fingerprintHash: fp.hash,
          fingerprintJson: fp.fingerprintJson,
          summary: fp.summary,
          intentSnapshot: freshest?.prompt ?? "",
          goalEmbedding: freshest?.embedding ?? [],
          source: "tacit",
        });
      }
    }
  }

  if (isBenchmarkFormat) {
    const verdict = result.judgeVerdict?.verdict
      ?? (result.allowed ? "consistent" : "hijacked");
    const confidence = result.judgeVerdict?.confidence ?? (result.allowed ? 0.95 : 0.90);
    const rationale = result.judgeVerdict?.reasoning ?? result.reason;
    return json(res, 200, { verdict, confidence, rationale });
  }

  json(res, 200, {
    ...hookResponse,
    _meta: {
      allowed: result.allowed,
      stage: lockState?.justLocked ? "session-locked" : result.stage,
      similarity: result.similarity,
      reason: lockState?.justLocked ? LOCKED_MESSAGE : result.reason,
      evaluationMs: result.evaluationMs,
      judgeVerdict: result.judgeVerdict
        ? {
            verdict: result.judgeVerdict.verdict,
            confidence: result.judgeVerdict.confidence,
            reasoning: result.judgeVerdict.reasoning,
          }
        : null,
      hijackStrikes: lockState?.strikes ?? (await tracker.getHijackStrikes(session_id)),
      locked: lockState?.locked ?? (await tracker.isLocked(session_id)),
    },
  });
}

export { handleEvaluate };
