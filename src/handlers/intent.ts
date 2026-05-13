/**
 * POST /intent — UserPromptSubmit handler.
 *
 * The most complex handler. Registers (or updates) the original
 * intent for a session, runs the embedding-fallback classifier on the
 * incoming prompt, kicks off the async LLM classifier (when enabled),
 * applies the resulting stack mutation via `applyIntentStackUpdate`,
 * scans any inline CLAUDE.md content for prompt-injection, and
 * synthesises the response that Claude Code injects into the
 * conversation.
 *
 * Extracted from server-hook.ts.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  tracker,
  interceptor,
  registeredSessions,
  feed,
  addFeed,
  readBody,
  json,
  BODY_LIMIT_TRANSCRIPT,
  rejectInvalidSessionId,
  safeServerReadablePath,
  authenticateHookRequest,
  authStageForFeed,
  backfillFromTranscript,
  backfillFromSummary,
  extractLastUserAndPriorAssistant,
  buildContextualIntent,
  applyIntentStackUpdate,
  applyClassifierOverride,
  describePhrasingMatches,
  NEW_TASK_DRIFT_MIN,
  CONFIG,
  type TrustMode,
} from "../server-core.js";
import type { ImageBlock } from "../session-store.js";
import {
  scanClaudeMd,
  scanClaudeMdContent,
  type ClaudeMdScanResult,
} from "../claudemd-scanner.js";
import {
  setPendingClassification,
} from "../intent-classifier.js";
import {
  effectiveMode,
  effectiveIntentHistoryMode,
  intentClassifier,
  INTENT_CLASSIFIER_LLM_ENABLED,
  CLASSIFIER_EVALUATE_WAIT_MS,
} from "./_shared.js";

// =========================================================================
// POST /intent — UserPromptSubmit
// =========================================================================
async function handleIntent(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req, BODY_LIMIT_TRANSCRIPT));
  const { session_id, prompt, transcript_path, cwd } = body;
  const transcriptContent: string | undefined = body.transcript_content;
  const transcriptSummary: unknown = body.transcript_summary;
  const claudeMdContent: string | undefined = body.claudemd_content;

  if (rejectInvalidSessionId(res, session_id)) return;
  if (!prompt) {
    return json(res, 400, { error: "Missing prompt" });
  }

  // Stamp the session owner from the validated API key so the dashboard
  // can scope sessions to the signed-in Clerk user. First writer wins;
  // calling more than once with the same key is idempotent.
  if (identity.keyValid && identity.ownerSub) {
    await tracker.setSessionOwner(session_id, identity.ownerSub, identity.ownerEmail);
  }

  if (cwd) {
    await tracker.setProjectRoot(session_id, cwd);

    if (!registeredSessions.has(session_id)) {
      let scan: ClaudeMdScanResult | null = null;
      if (claudeMdContent) {
        scan = scanClaudeMdContent(claudeMdContent, `${cwd}/CLAUDE.md`);
      } else {
        const safeCwd = safeServerReadablePath(cwd);
        if (safeCwd) {
          scan = scanClaudeMd(safeCwd);
        }
      }
      if (scan && scan.findings.length > 0) {
        console.warn(`  [${session_id.substring(0, 8)}] [CLAUDEMD-SCAN] ${scan.summary}`);
        for (const f of scan.findings) {
          console.warn(`    ${f.severity.toUpperCase()} ${f.pattern} (${f.file}:${f.line}): ${f.snippet}`);
        }
        await tracker.recordClaudeMdScan(session_id, scan);
      }
    }
  }

  if (!registeredSessions.has(session_id)) {
    // Prefer the structured summary envelope — it skips the JSONL
    // parse and ships ~5KB instead of ~800KB on a long session.
    // Falls back to the raw transcript paths so an old hook can
    // still talk to a new server during the rollout window.
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

  const mode: TrustMode = effectiveMode(session_id, body.mode);

  // priorAssistant + image blocks for THIS prompt. The summary
  // envelope provides them directly; otherwise re-derive from the
  // raw transcript.
  const summaryPrior =
    transcriptSummary && typeof transcriptSummary === "object"
      ? (transcriptSummary as { priorAssistantText?: string | null; lastUserImages?: ImageBlock[] })
      : null;
  const { priorAssistant, images: transcriptImages } = summaryPrior
    ? {
        priorAssistant: summaryPrior.priorAssistantText ?? null,
        images: Array.isArray(summaryPrior.lastUserImages) ? summaryPrior.lastUserImages : [],
      }
    : transcriptContent
      ? extractLastUserAndPriorAssistant(transcriptContent, true)
      : transcript_path
        ? extractLastUserAndPriorAssistant(transcript_path)
        : { priorAssistant: null, images: [] as ImageBlock[] };

  // Treat short replies as confirmations of the previous turn rather than
  // standalone goals. Includes "option N" / "option foo" so users picking
  // from a clarifying question don't reset the goal to a meaningless
  // 2-word string. Stays in sync with isConfirmationPrompt() in
  // server-core.ts (used by transcript backfill) — divergence here was
  // the cause of "option 2" being treated as a new goal and tripping
  // drift-deny on the next tool call.
  //
  // Computed up-front so we can persist the classification on the
  // TurnIntent (the dashboard renders confirmation entries differently
  // from real goal pivots).
  const confirmationOnly =
    /^\s*(yes|yeah|yep|ok|okay|sure|do it|go ahead|go|proceed|continue|y|k|confirm|approved?|lgtm|ship it|sounds good|that's right|correct|exactly|please|thanks|thank you|option\s+\w+|👍)\s*[.!?👍]*\s*$/i;
  const isConfirmation = confirmationOnly.test(prompt) && prompt.trim().length < 80;

  // Read the prior turn-state markers BEFORE we register this prompt;
  // the stack classifier needs to see "what was the state when the user
  // hit Enter?", not "what is it now we've recorded the new event?".
  const prevTimings = await tracker.noteUserPromptSubmit(session_id);

  const result = await tracker.registerIntent(session_id, prompt, mode === "interactive", transcriptImages, isConfirmation);

  const contextualGoal = buildContextualIntent(prompt, priorAssistant);

  if (transcriptImages.length) {
    console.log(
      `  [${session_id.substring(0, 8)}] [INTENT] ${transcriptImages.length} image(s) attached to intent`
    );
  }

  if (result.isOriginal && !registeredSessions.has(session_id)) {
    await interceptor.registerGoal(session_id, contextualGoal, transcriptImages);
    registeredSessions.add(session_id);
  } else if (!result.isOriginal && !registeredSessions.has(session_id)) {
    // Continuation prompt landed on a container that doesn't have
    // the session in its in-memory Set. Two cases collapse here:
    //
    //   (a) Fresh container after redeploy — session was registered
    //       on the old container, the SessionStore still has it, the
    //       new container's Set is empty.
    //   (b) `claude --continue` after a SessionEnd — /end stamped
    //       endedAt and removed the Set entry, the user resumed with
    //       the same session_id. SessionStore still has originalIntent
    //       (TTL 30d).
    //
    // Prefer the LIVE active set over originalIntent — see /evaluate's
    // rehydration block for the same fix. Originalintent is potentially
    // stale on long-running sessions; the active set is what the
    // classifier most recently decided was live.
    const persistedActive = await tracker.getActiveIntents(session_id);
    let goalToRegister: string;
    if (persistedActive.length > 0) {
      const freshest = persistedActive[persistedActive.length - 1];
      goalToRegister = freshest.contextual;
    } else {
      const persisted = await tracker.loadSession(session_id);
      goalToRegister = persisted?.originalIntent?.prompt ?? contextualGoal;
    }
    await interceptor.registerGoal(session_id, goalToRegister, transcriptImages);
    registeredSessions.add(session_id);
    console.log(
      `  [${session_id.substring(0, 8)}] [REHYDRATE] continuation/redeploy — restored goal: "${goalToRegister.substring(0, 60)}..." (active=${persistedActive.length})`,
    );
  }

  // Autonomous-mode topic-switch handling. Without this, the
  // interceptor's per-session originalTask is set once on first
  // registerIntent and never updates — long-lived sessions stay
  // anchored to a stale turn-1 goal even after the user has
  // explicitly pivoted. Mirror what the interactive path does on
  // new-task: re-register the goal so the judge sees the right
  // anchor. Skip on confirmations (those don't carry a new goal)
  // and on the first prompt of the session (already handled above).
  if (
    mode === "autonomous" &&
    !isConfirmation &&
    !result.isOriginal &&
    result.driftFromOriginal !== null &&
    result.driftFromOriginal > NEW_TASK_DRIFT_MIN
  ) {
    console.log(
      `  [${session_id.substring(0, 8)}] [INTENT] autonomous topic switch ` +
      `(drift=${result.driftFromOriginal.toFixed(3)} > ${NEW_TASK_DRIFT_MIN}) — ` +
      `re-registering goal`
    );
    await interceptor.registerGoal(session_id, contextualGoal, transcriptImages);
    await tracker.replaceOriginalIntent(session_id, prompt);
  }

  // Hoisted so the feed entry below can include the classification —
  // null in autonomous mode (single-goal, no stack semantics).
  let stackUpdate: import("./server-core.js").IntentStackUpdateResult | null = null;
  if (mode === "interactive" || mode === "learn") {
    // Stack-aware intent update. The stack absorbs queued prompts (the
    // LLM combines them at the next generation boundary), adopts the
    // assistant proposal on confirmation, and only clears prior intents
    // on a true topic switch (closed state, drift > NEW_TASK_DRIFT_MIN).
    stackUpdate = await applyIntentStackUpdate(
      tracker,
      session_id,
      prompt,
      priorAssistant,
      isConfirmation,
      prevTimings,
      CONFIG.embeddingModel,
      transcriptImages,
      effectiveIntentHistoryMode(session_id),
    );

    // Re-seed the interceptor's per-session goal state from the stack.
    // The interceptor's drift detector is the same instance the store
    // tracks (passed by reference), so setActiveIntents already updated
    // the goalEmbeddings — but registerGoal also resets goalStartIndex
    // (the boundary for "tools belonging to the current task"). On
    // continuation we keep the existing index; on new-task / original
    // we reset it. confirmation gets the proposal as the contextual
    // goal so the judge sees what the user agreed to.
    if (
      stackUpdate.kind === "new-task" ||
      stackUpdate.kind === "original"
    ) {
      // Use the contextual form so the judge sees prior_assistant_response
      // when relevant — same as the previous behaviour.
      await interceptor.registerGoal(session_id, contextualGoal, transcriptImages);
    } else if (stackUpdate.kind === "confirmation" && priorAssistant) {
      await interceptor.registerGoal(session_id, contextualGoal, transcriptImages);
    }
    // queued / open-followup / continuation: don't reset the goal
    // boundary — those are *additions* to what the agent is allowed
    // to do, not a replacement.

    const stackPrompts = stackUpdate.stack
      .map((e: { prompt: string; kind: string; resolved: boolean }) => `"${e.prompt.substring(0, 30)}"(${e.kind}${e.resolved ? "*" : ""})`)
      .join(" → ");
    console.log(
      `  [${session_id.substring(0, 8)}] [INTENT] ${mode} mode: ` +
      `${stackUpdate.kind} (turn-state=${stackUpdate.turnState}, ` +
      `drift=${stackUpdate.driftToStackTop?.toFixed(3) ?? "n/a"}, ` +
      `stack=${stackUpdate.stack.length}: ${stackPrompts})`
    );

    // Telemetry: emit one feed entry per /intent recording the
    // embedding-fallback verdict. The async LLM override (below)
    // emits a follow-up entry with classifierOverridden flag set.
    addFeed({
      timestamp: new Date().toISOString(),
      type: "intent-classify",
      sessionId: session_id,
      ownerSub: identity.ownerSub,
      authStage: authStageForFeed(identity),
      intentKind: stackUpdate.kind,
      intentStackSize: stackUpdate.stack.length,
      classifierSource: "embedding",
    });

    // Async LLM classifier override. Spawn a Bedrock call to second-
    // guess the embedding fallback. /intent has already returned to
    // the caller; this happens in the background. /evaluate awaits
    // the result with a bounded timeout (CLASSIFIER_EVALUATE_WAIT_MS)
    // so a fast classifier verdict can correct the active set before
    // the agent's first tool call. /end and /pivot cancel pending
    // classifications.
    //
    // Only run when:
    //   - feature flag is on
    //   - we have a real new entry (not queued/open-followup, where
    //     the kind is already determined by turn state and the LLM
    //     has nothing to add)
    //   - the embedding-fallback kind is not "original" (first prompt
    //     of session is unambiguous)
    if (
      INTENT_CLASSIFIER_LLM_ENABLED &&
      stackUpdate.newEntryId &&
      stackUpdate.kind !== "queued" &&
      stackUpdate.kind !== "open-followup" &&
      stackUpdate.kind !== "original"
    ) {
      const newEntryId = stackUpdate.newEntryId;
      const embeddingKind = stackUpdate.kind;
      const turnState = stackUpdate.turnState;
      const ownerSub = identity.ownerSub;
      const authStageForLater = authStageForFeed(identity);
      const classifierPromise = (async () => {
        const active = await tracker.getActiveIntents(session_id);
        const history = await tracker.getIntentHistory(session_id);
        const verdict = await intentClassifier.classify(prompt, active, history, turnState);
        if (verdict) {
          const result = await applyClassifierOverride(
            tracker,
            session_id,
            newEntryId,
            verdict,
          ).catch((err) => {
            console.warn(
              `  [${session_id.substring(0, 8)}] [INTENT-CLASSIFY] override failed: ${err}`,
            );
            return { overridden: false, reason: `override error: ${err}`, embeddingKind: undefined };
          });
          // When the LLM overrode the embedding, log which phrasing
          // patterns the prompt did/didn't match — tells us whether
          // the embedding missed because of a gap in the pattern set
          // (expand patterns) or a drift threshold problem (tune it).
          let phrasingNote = "";
          if (result.overridden) {
            const m = describePhrasingMatches(prompt);
            phrasingNote = ` phrasing[revisit=${m.revisit ? "Y" : "N"} replacement=${m.replacement ? "Y" : "N"} subtask=${m.subTask ? "Y" : "N"}]`;
          }
          console.log(
            `  [${session_id.substring(0, 8)}] [INTENT-CLASSIFY-LLM] kind=${verdict.kind} ` +
            `conf=${verdict.confidence} (${verdict.durationMs}ms) overridden=${result.overridden}${phrasingNote} ` +
            `(${result.reason})`,
          );
          // Telemetry: record what the LLM said and whether it changed the
          // active set. Dashboards aggregate by classifierOverridden to
          // measure the embedding-vs-LLM disagreement rate.
          addFeed({
            timestamp: new Date().toISOString(),
            type: "intent-classify-llm",
            sessionId: session_id,
            ownerSub,
            authStage: authStageForLater,
            intentKind: verdict.kind,
            classifierSource: result.overridden ? "llm" : "llm-confirmed",
            classifierConfidence: verdict.confidence,
            classifierLatencyMs: verdict.durationMs,
            classifierOverridden: result.overridden,
            classifierEmbeddingKind: result.overridden ? embeddingKind : undefined,
          });
        } else {
          // LLM never returned (timeout, parse error, Bedrock outage).
          // Embedding fallback persists; record the failure for telemetry.
          addFeed({
            timestamp: new Date().toISOString(),
            type: "intent-classify-llm",
            sessionId: session_id,
            ownerSub,
            authStage: authStageForLater,
            intentKind: embeddingKind,
            classifierSource: "embedding-fallback-timeout",
            classifierOverridden: false,
          });
        }
        return verdict;
      })();
      setPendingClassification(session_id, classifierPromise);
    }
  }

  const classification = tracker.classifyDrift(result.driftFromOriginal);
  const reminder = mode === "autonomous"
    ? await tracker.getGoalReminder(session_id, result.driftFromOriginal)
    : null;

  const hookResponse: Record<string, unknown> = {};
  if (reminder) {
    hookResponse.systemMessage = reminder;
  }

  addFeed({
    timestamp: new Date().toISOString(),
    type: "intent",
    prompt: prompt.substring(0, 500),
    sessionId: session_id,
    reason: `Turn ${result.turnNumber}: ${classification}${result.driftFromOriginal !== null ? ` (drift: ${result.driftFromOriginal.toFixed(3)})` : ""}`,
    ownerSub: identity.ownerSub,
    authStage: authStageForFeed(identity),
    intentKind: stackUpdate?.kind,
    intentStackSize: stackUpdate?.stack.length,
  });

  json(res, 200, {
    ...hookResponse,
    _meta: {
      isOriginal: result.isOriginal,
      turnNumber: result.turnNumber,
      driftFromOriginal: result.driftFromOriginal,
      driftFromPrevious: result.driftFromPrevious,
      classification,
    },
  });
}


export { handleIntent };
