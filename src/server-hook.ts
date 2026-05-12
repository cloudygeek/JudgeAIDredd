/**
 * Hook-facing HTTP server.
 *
 * Hosts the hot path: POST /intent, /evaluate, /track, /end, /pivot,
 * /compact, /register. Plus status endpoints: /health, /api/health,
 * /api/data-status, /api/whoami. Plus the feed (cross-origin from the
 * dashboard) and the runtime mode toggle.
 *
 * What deliberately does NOT live here: dashboard HTML, session listings,
 * log file downloads, policies dump. Those live in `server-dashboard.ts`
 * and run in a separate container behind OIDC.
 *
 * CORS: /api/feed and /api/mode accept cross-origin requests from
 * DREDD_DASHBOARD_ORIGIN so the dashboard container's page can call them.
 * Every other endpoint is same-origin (the hook calls its own URL directly).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PORT,
  CONFIG,
  tracker,
  apiKeys,
  interceptor,
  registeredSessions,
  feed,
  addFeed,
  recordNotification,
  getNotificationCount,
  readBody,
  json,
  BODY_LIMIT_TRANSCRIPT,
  BodyTooLargeError,
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
  buildSessionLogShape,
  flushLogs,
  NEW_TASK_DRIFT_MIN,
  AUTH_MODE,
  type TrustMode,
} from "./server-core.js";
import type { ImageBlock } from "./session-store.js";
import { scanClaudeMd, scanClaudeMdContent, type ClaudeMdScanResult } from "./claudemd-scanner.js";
import {
  IntentClassifier,
  setPendingClassification,
  awaitPendingClassification,
  cancelPendingClassification,
} from "./intent-classifier.js";
import { CLERK_PUBLISHABLE_KEY } from "./clerk-auth.js";

// CORS origin the dashboard container runs at. When unset, cross-origin
// requests are rejected — same-origin only, which is what the hook gets
// from Claude Code hooks.
const DASHBOARD_ORIGIN = process.env.DREDD_DASHBOARD_ORIGIN ?? "";

// History-active model rollout — top-level flag gating the new
// intent-classifier behaviour. Layered with INTENT_CLASSIFIER_LLM_ENABLED
// so we can stage the rollout:
//
//   legacy (default):
//     - Schema layer always runs (Steps 1-2 are behaviour-equivalent;
//       existing call sites use getActiveIntents/setActiveIntents and
//       see exactly the legacy stack).
//     - The new sub-task / replacement / revisit kinds DO NOT fire.
//     - Judge sees the legacy plain numbered list (no [annotation]
//       suffixes).
//     - The async LLM classifier never starts.
//
//   history-active:
//     - The Step-3 embedding classifier produces the new kinds.
//     - Judge prompt renders parent/child + replacement annotations.
//     - LLM classifier may run if INTENT_CLASSIFIER_LLM_ENABLED is
//       also true.
//
// Step-6 staged rollout: enable history-active first (cost-neutral —
// just smarter classification + richer judge prompts). Once telemetry
// confirms the classification rates look sensible, flip
// INTENT_CLASSIFIER_LLM_ENABLED to add the LLM safety net.
export const INTENT_HISTORY_MODE: "legacy" | "history-active" =
  process.env.INTENT_HISTORY_MODE === "history-active" ? "history-active" : "legacy";

const INTENT_CLASSIFIER_LLM_ENABLED =
  process.env.INTENT_CLASSIFIER_LLM_ENABLED === "true"
  && INTENT_HISTORY_MODE === "history-active";
const intentClassifier = new IntentClassifier(
  (process.env.INTENT_CLASSIFIER_BACKEND as "bedrock" | "ollama" | undefined) ?? "bedrock",
  process.env.INTENT_CLASSIFIER_MODEL ?? "eu.anthropic.claude-sonnet-4-6",
);
/** How long /evaluate waits for an in-flight classifier verdict
 *  before falling back to the existing active state. Cap chosen to
 *  stay below typical agent-response latency so it's hidden in
 *  normal flow. */
const CLASSIFIER_EVALUATE_WAIT_MS = 750;

// Build version, surfaced in every permissionDecisionReason so users can
// tell which deployment produced an error. Read once at module load —
// package.json is baked into the image, so re-reading per request adds no
// information.
const PKG_VERSION: string = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ).version as string;
  } catch {
    return "unknown";
  }
})();
const DREDD_TAG = `Judge AI Dredd [v${PKG_VERSION}]`;

// Per-session trust-mode override. Set via POST /api/session-mode from the
// dashboard. Beats body.mode and CONFIG.mode for that one session — used to
// rescue stuck sessions where the LLM stack classifier has locked onto a
// stale goal and every command trips drift-deny. In-memory; cleared on
// container restart. ALB stickiness keeps the session pinned to one task
// so the override stays effective for the session's lifetime.
const sessionModeOverride = new Map<string, TrustMode>();

function effectiveMode(session_id: string, bodyMode: unknown): TrustMode {
  const override = sessionModeOverride.get(session_id);
  if (override) return override;
  return ((bodyMode as TrustMode | undefined) ?? CONFIG.mode);
}

// Per-session intent-history-model override. Same shape as
// sessionModeOverride but for the history-active rollout — lets a
// sandbox A/B-test history-active on one session while production
// stays on legacy. Set via POST /api/session-intent-mode.
const sessionIntentModeOverride = new Map<string, "legacy" | "history-active">();

function effectiveIntentHistoryMode(session_id: string): boolean {
  const override = sessionIntentModeOverride.get(session_id);
  if (override) return override === "history-active";
  return INTENT_HISTORY_MODE === "history-active";
}

// PromptArmor /screen allow-list. Only models from the head-to-head
// test plan (B1) are accepted — without this, any authenticated key
// could trigger arbitrary expensive Bedrock/OpenAI calls. Substring
// match so callers can pass either friendly names or fully-qualified
// IDs (e.g. "eu.anthropic.claude-sonnet-4-6"). Body cap is enforced
// separately via BODY_LIMIT_DEFAULT in readBody.
const PROMPTARMOR_ALLOWED_MODELS: ReadonlyArray<string> = [
  "gpt-4o",
  "gpt-4.1",
  "o4-mini",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "qwen3-32b",
  "qwen3-235b",
];

const PROMPTARMOR_MAX_CONTENT_BYTES = 32 * 1024;

// Cap concurrent /screen calls so a Bedrock-side stall can't queue
// hundreds of in-flight requests on the event loop. Each /screen call
// blocks on a Bedrock Converse round-trip (~1-3s typical, longer when
// throttled). Without this cap, a stuck request snowballs: queue
// grows, no slack for ALB health checks, container goes silent.
// Observed: 2026-05-10T03:17 -> 07:32 UTC outage where the hook went
// quiet after a stuck /screen call hung the event loop. Override via
// PROMPTARMOR_SCREEN_CONCURRENCY env if needed.
const PROMPTARMOR_SCREEN_CONCURRENCY = parseInt(
  process.env.PROMPTARMOR_SCREEN_CONCURRENCY ?? "8",
  10,
);
let screenInFlight = 0;
const screenWaiters: Array<() => void> = [];

function acquireScreenSlot(): Promise<void> {
  if (screenInFlight < PROMPTARMOR_SCREEN_CONCURRENCY) {
    screenInFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    screenWaiters.push(() => {
      screenInFlight++;
      resolve();
    });
  });
}

function releaseScreenSlot(): void {
  screenInFlight--;
  const next = screenWaiters.shift();
  if (next) next();
}

/**
 * Apply CORS headers for endpoints the dashboard container calls. Returns
 * true and ends the response for OPTIONS preflight so the caller can bail.
 */
/**
 * Render process uptime as a compact human-readable string for the
 * landing page. Three thresholds: <1m → "Ns", <1h → "Nm Ns",
 * otherwise "Nh Nm". Days roll into hours so a 60h-old container
 * shows "60h" rather than "2d 12h" — the operator usually wants to
 * see "this is older than X" rather than the calendar split.
 */
function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  if (!DASHBOARD_ORIGIN) return false;
  const origin = req.headers.origin;
  if (origin !== DASHBOARD_ORIGIN) return false;
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

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
      .map((e) => `"${e.prompt.substring(0, 30)}"(${e.kind}${e.resolved ? "*" : ""})`)
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

// =========================================================================
// POST /register — Benchmark-compatible session registration
// =========================================================================
async function handleRegister(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { task } = body;
  if (!task) {
    return json(res, 400, { error: "Missing task" });
  }
  const sessionId = `bench-${crypto.randomUUID()}`;
  await tracker.registerIntent(sessionId, task, CONFIG.mode === "interactive");
  await interceptor.registerGoal(sessionId, task);
  registeredSessions.add(sessionId);
  console.log(`  [${sessionId.substring(0, 8)}] [REGISTER] benchmark session: "${task.substring(0, 60)}..."`);
  json(res, 200, { session: sessionId });
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
      await interceptor.registerGoal(session_id, freshest.contextual);
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
      await interceptor.registerGoal(session_id, contextual);
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
      const policyOnly = (await import("./tool-policy.js")).evaluateToolPolicy(tool_name, tool_input ?? {}, projectRoot);
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

  const result = await interceptor.evaluate(
    session_id,
    tool_name,
    tool_input ?? {},
    fullContext || undefined,
    await tracker.getProjectRoot(session_id),
    mode,
    activeIntents,
    effectiveIntentHistoryMode(session_id),
  );

  await tracker.recordToolCall(
    session_id,
    tool_name,
    tool_input ?? {},
    result.allowed ? "allow" : "deny",
    result.similarity,
    tool_use_id,
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
    } else if (mode === "interactive") {
      // Surface as an "ask" — Claude Code shows the user a
      // permission prompt with our reason. The reason text is
      // user-facing, so phrase it accordingly: lead with the
      // suspicion, end with what to check.
      const askReason =
        `${DREDD_TAG}: this tool call looks suspicious. ${result.reason}. ` +
        `Review and approve only if this matches your intent.`;
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

// =========================================================================
// POST /track — PostToolUse
// =========================================================================
async function handleTrack(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id, tool_name, tool_input, tool_output } = body;

  if (rejectInvalidSessionId(res, session_id)) return;
  if (!tool_name) {
    return json(res, 400, { error: "Missing tool_name" });
  }

  if (tool_name === "Read") {
    await tracker.recordFileRead(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_output ?? "")
    );
  }

  if (tool_name === "Write") {
    await tracker.recordFileWrite(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_input?.content ?? ""),
      false
    );
  }

  if (tool_name === "Edit") {
    await tracker.recordFileWrite(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_input?.new_string ?? ""),
      true
    );
  }

  if (tool_name === "Bash") {
    await tracker.recordEnvVar(session_id, String(tool_input?.command ?? ""));
  }

  json(res, 200, {});
}

// =========================================================================
// POST /end — Stop
// =========================================================================
async function handleEnd(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  const sessionLog = await buildSessionLogShape(session_id);
  const summary = (sessionLog?.summary as any) ?? { turns: 0, toolCalls: 0, denied: 0 };

  console.log(
    `[END] Session ${session_id.substring(0, 8)}: ` +
    `${summary.turns} turns, ${summary.toolCalls} tools, ` +
    `${summary.denied} denied`
  );

  registeredSessions.delete(session_id);
  cancelPendingClassification(session_id);
  await tracker.endSession(session_id);
  interceptor.reset(session_id);

  json(res, 200, { summary });
}

// =========================================================================
// POST /stop — Stop hook (turn boundary, NOT session end)
// =========================================================================
//
// Claude Code fires Stop after every assistant turn. We use it to mark
// the turn boundary in the per-session timing markers so the next
// /intent can derive turnState correctly:
//   - lastStopAt updated to now
//   - all activeIntents marked resolved (so the next "new-task"
//     classification can evict them)
//
// Session END comes through /end via the SessionEnd hook; this endpoint
// is purely a turn-boundary signal.
async function handleStop(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  await tracker.noteStop(session_id).catch((err) => {
    console.warn(`  [${session_id.substring(0, 8)}] noteStop failed: ${err}`);
  });

  json(res, 200, {});
}

// =========================================================================
// POST /notification — Notification hook
// =========================================================================
//
// Claude Code fires the Notification hook whenever it surfaces a
// permission/notification dialog to the user. This is the only signal we
// have that Claude prompted the user *despite* Dredd having returned a
// PreToolUse decision earlier in the same turn — i.e. friction Dredd
// could not eliminate. We record a per-session counter and a feed entry
// so the dashboard and the A/B harness can read the friction number.
async function handleNotification(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id, message } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  const count = recordNotification(session_id);

  addFeed({
    timestamp: new Date().toISOString(),
    type: "notification",
    sessionId: session_id,
    reason: typeof message === "string" ? message.substring(0, 500) : "",
    ownerSub: identity.ownerSub,
    authStage: authStageForFeed(identity),
  });

  json(res, 200, { count });
}

// =========================================================================
// GET /api/notifications/:id — read-back for the friction harness.
// =========================================================================
//
// The dashboard already reads /api/feed cross-origin and can derive this
// itself from the notification entries; the dedicated endpoint is for
// the A/B harness which talks directly to the hook container.
function handleNotificationsGet(res: ServerResponse, sessionId: string) {
  if (rejectInvalidSessionId(res, sessionId)) return;
  json(res, 200, {
    sessionId,
    count: getNotificationCount(sessionId),
  });
}

// =========================================================================
// GET /session/:id — Debug
// =========================================================================
async function handleSessionGet(res: ServerResponse, sessionId: string) {
  if (rejectInvalidSessionId(res, sessionId)) return;
  const ctx = await tracker.getSessionContext(sessionId);
  const summary = await tracker.getFullSessionSummary(sessionId);
  json(res, 200, { ...ctx, summary });
}

// =========================================================================
// POST /pivot / /compact
// =========================================================================
async function handlePivot(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id, reason } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  await tracker.pivotSession(session_id, reason ?? "User changed direction");

  interceptor.reset(session_id);
  registeredSessions.delete(session_id);
  cancelPendingClassification(session_id);

  json(res, 200, { pivoted: true, reason: reason ?? "User changed direction" });
}

async function handleCompact(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  console.log(
    `  [COMPACT] Session ${session_id.substring(0, 8)}: context compaction detected`
  );

  await tracker.recordTurnMetrics(
    session_id,
    null,
    null,
    0,
    0,
    false,
    false
  );

  json(res, 200, { noted: true });
}

// =========================================================================
// POST /screen — PromptArmor side-channel for benchmark runners
// =========================================================================
//
// Body: {
//   content: string,           // untrusted blob to screen
//   task_context?: string,     // forward-compat — currently logged only
//   backend: "openai" | "bedrock",
//   model: string,             // must be one of PROMPTARMOR_ALLOWED_MODELS
//   run_id?: string,           // appends to results/promptarmor/<run_id>/calls.jsonl
//   temperature?: number,      // default 0
// }
//
// Auth: same Bearer-key gate as the rest of the hook surface.
// Side-effects: appends to the run's calls.jsonl when run_id is set.
//   Does NOT touch SessionTracker — this is benchmark plumbing, not a
//   Dredd-protected operation.
async function handleScreen(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const content = body.content;
  const taskContext = body.task_context;
  const backend = body.backend;
  const model = body.model;
  const runId = body.run_id;
  const temperature = body.temperature;

  if (typeof content !== "string") {
    return json(res, 400, { error: "content must be a string" });
  }
  if (Buffer.byteLength(content, "utf8") > PROMPTARMOR_MAX_CONTENT_BYTES) {
    return json(res, 413, {
      error: `content exceeds ${PROMPTARMOR_MAX_CONTENT_BYTES} bytes`,
    });
  }
  if (taskContext !== undefined && typeof taskContext !== "string") {
    return json(res, 400, { error: "task_context must be a string when provided" });
  }
  if (backend !== "openai" && backend !== "bedrock") {
    return json(res, 400, { error: "backend must be openai or bedrock" });
  }
  if (typeof model !== "string" || !PROMPTARMOR_ALLOWED_MODELS.some((m) => model.includes(m))) {
    return json(res, 400, {
      error: `model not allowed; must contain one of: ${PROMPTARMOR_ALLOWED_MODELS.join(", ")}`,
    });
  }
  if (runId !== undefined && (typeof runId !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(runId))) {
    return json(res, 400, { error: "run_id must match [a-zA-Z0-9._-]{1,64}" });
  }
  if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) {
    return json(res, 400, { error: "temperature must be a number in [0, 2]" });
  }

  const { PromptArmorBaseline } = await import("./promptarmor-baseline.js");
  const baseline = new PromptArmorBaseline({
    backend,
    model,
    temperature,
    runId,
  });

  await acquireScreenSlot();
  try {
    const result = await baseline.screen(content, taskContext);
    return json(res, 200, {
      verdict: result.verdict,
      sanitised: result.sanitised,
      latency_ms: result.latencyMs,
      tokens: { in: result.tokens.in, out: result.tokens.out },
      injection: result.injection,
      sanitisation_failed: result.sanitisationFailed,
      run_id: runId ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [/screen] backend ${backend} failed: ${msg}`);
    return json(res, 502, { error: "detector backend failed", detail: msg });
  } finally {
    releaseScreenSlot();
  }
}

// =========================================================================
// Router
// =========================================================================
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    // GET / — tiny status landing page. The hook container has no
    // dashboard UI (that lives on the dashboard container). This page
    // is for operators / users who hit the URL directly to confirm
    // which container is on the other end and link them onward.
    if (req.method === "GET" && url.pathname === "/") {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      const dashboardOrigin = process.env.DREDD_DASHBOARD_ORIGIN ?? "";
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<script>window.CLERK_PUBLISHABLE_KEY=${JSON.stringify(CLERK_PUBLISHABLE_KEY)};</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Judge AI Dredd — Hook API</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 40px 24px; }
  .card { max-width: 720px; margin: 0 auto; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #f0f6fc; }
  h1 span { color: #58a6ff; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; font-size: 13px; margin: 20px 0; }
  .k { color: #8b949e; }
  .v { color: #c9d1d9; word-break: break-all; }
  .v.green { color: #3fb950; }
  .v.amber { color: #d29922; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb; }
  ul { list-style: none; padding: 0; margin: 16px 0; }
  li { padding: 4px 0; }
  li code { color: #d29922; }
  a { color: #58a6ff; }
  .muted { color: #8b949e; font-size: 12px; margin-top: 24px; line-height: 1.6; }
  .mode-select {
    background: #0d1117; color: #c9d1d9;
    border: 1px solid #30363d; border-radius: 6px;
    padding: 2px 8px; font: inherit; font-size: 13px; cursor: pointer;
  }
  .mode-select:hover { border-color: #8b949e; }
  .mode-select.mode-interactive { background: #d29922; color: #000; border-color: #d29922; }
  .mode-select.mode-autonomous { background: #f85149; color: #fff; border-color: #f85149; }
  .mode-select.mode-learn { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  #mode-status { color: #8b949e; font-size: 11px; margin-left: 8px; }
  #mode-status.err { color: #f85149; }
  #mode-status.ok { color: #3fb950; }
  /* Sign-in overlay — mirrors dashboard.html's gate. */
  .signin-overlay {
    position: fixed; inset: 0; background: #0d1117;
    display: flex; align-items: center; justify-content: center;
    z-index: 5000;
  }
  .signin-card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 32px 36px; max-width: 420px; text-align: center;
  }
  .signin-card h1 { font-size: 22px; margin-bottom: 4px; }
  .signin-card p { color: #8b949e; font-size: 14px; margin: 12px 0 24px; }
  .signin-btn {
    background: #1f6feb; color: #fff; border: none;
    border-radius: 6px; padding: 10px 18px; font-size: 14px;
    font-weight: 600; cursor: pointer;
  }
  .signin-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .signout-btn {
    background: transparent; color: #8b949e; border: 1px solid #30363d;
    border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer;
    font-family: inherit;
  }
  .signout-btn:hover { color: #c9d1d9; border-color: #8b949e; }
</style>
</head>
<body>
<div id="signin-overlay" class="signin-overlay">
  <div class="signin-card">
    <h1>Judge AI <span>Dredd</span></h1>
    <p id="signin-msg">Loading sign-in…</p>
    <button id="signin-btn" class="signin-btn" disabled onclick="dreddSignIn()">Sign in</button>
  </div>
</div>
<div id="main-page" class="card" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
    <div>
      <h1>Judge AI <span>Dredd</span> — Hook API</h1>
      <div class="sub">PreToolUse defence service for Claude Code hooks. <span class="pill">role: hook</span></div>
    </div>
    <div style="text-align:right;font-size:11px;color:#8b949e;white-space:nowrap">
      <div id="signed-in-as" style="margin-bottom:6px"></div>
      <button class="signout-btn" onclick="dreddSignOut()">Sign out</button>
    </div>
  </div>

  <div class="grid">
    <div class="k">Version</div><div class="v">${pkg.version}</div>
    <div class="k">Status</div><div class="v green">ok</div>
    <div class="k">Uptime</div><div class="v">${formatUptime(process.uptime())}</div>
    <div class="k">Mode</div><div class="v">
      <select id="mode-select" class="mode-select mode-${CONFIG.mode}" onchange="switchMode(this.value)" title="Flip the global trust mode for this hook container">
        <option value="interactive"${CONFIG.mode === "interactive" ? " selected" : ""}>interactive</option>
        <option value="autonomous"${CONFIG.mode === "autonomous" ? " selected" : ""}>autonomous</option>
        <option value="learn"${CONFIG.mode === "learn" ? " selected" : ""}>learn</option>
      </select>
      <span id="mode-status"></span>
    </div>
    <div class="k">Backend</div><div class="v">${CONFIG.judgeBackend}</div>
    <div class="k">Judge model</div><div class="v">${CONFIG.judgeModel}</div>
    <div class="k">Embedding</div><div class="v">${CONFIG.embeddingModel}</div>
    <div class="k">Prompt variant</div><div class="v">${CONFIG.hardened || "standard"}</div>
    <div class="k">Intent model</div><div class="v ${INTENT_HISTORY_MODE === "history-active" ? "green" : ""}">${INTENT_HISTORY_MODE}</div>
    <div class="k">LLM classifier</div><div class="v ${INTENT_CLASSIFIER_LLM_ENABLED ? "green" : "amber"}">${INTENT_CLASSIFIER_LLM_ENABLED ? "enabled" : "disabled"}</div>
    <div class="k">Active sessions</div><div class="v">${registeredSessions.size}</div>
    <div class="k">Auth mode</div><div class="v ${AUTH_MODE === "required" ? "green" : "amber"}">${AUTH_MODE}</div>
  </div>

  <div style="font-size: 12px; color: #8b949e; margin: 16px 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Hook endpoints</div>
  <ul>
    <li><code>POST /intent</code> — UserPromptSubmit</li>
    <li><code>POST /evaluate</code> — PreToolUse (judge pipeline)</li>
    <li><code>POST /track</code> — PostToolUse</li>
    <li><code>POST /end</code> · <code>/pivot</code> · <code>/compact</code></li>
    <li><code>POST /screen</code> — PromptArmor detector (benchmark side-channel)</li>
    <li><code>GET /api/health</code> · <code>/api/whoami</code> · <code>/api/data-status</code></li>
    <li><code>GET /api/feed</code> · <code>POST /api/mode</code> · <code>POST /api/session-mode</code> · <code>GET /api/session-modes</code> <span style="color:#8b949e">(cross-origin from dashboard)</span></li>
  </ul>

  <div class="muted">
    The full operator dashboard lives on a separate container.
    ${dashboardOrigin ? `<br>Dashboard: <a href="${dashboardOrigin}">${dashboardOrigin}</a>` : `<br>Dashboard origin not configured (DREDD_DASHBOARD_ORIGIN unset).`}
    <br>To install the hook in your project, run <code>curl -O ${"https://" + (req.headers["x-forwarded-host"] || req.headers.host || "localhost")}/api/integration-bundle</code> from the dashboard.
  </div>
</div>
<script>
// ------------------------------------------------------------------
// Clerk authentication gate. Mirrors the flow in src/web/dashboard.html:
// load @clerk/clerk-js from the frontend API derived from the
// publishable key, then reveal #main-page only after Clerk reports a
// signed-in user. The hook API endpoints (/intent, /evaluate, /track,
// /api/mode, etc.) are deliberately unchanged — they keep their
// existing Bearer-API-key + CORS auth. This gate is presentation only.
// ------------------------------------------------------------------
const CLERK_PUBLISHABLE_KEY = window.CLERK_PUBLISHABLE_KEY || "";

async function loadClerkSdk() {
  if (!CLERK_PUBLISHABLE_KEY) {
    document.getElementById('signin-msg').textContent =
      'Hook UI auth not configured (CLERK_PUBLISHABLE_KEY missing on this container).';
    return null;
  }
  const partsB64 = CLERK_PUBLISHABLE_KEY.split('_')[2] || '';
  let frontendApi = '';
  try {
    frontendApi = atob(partsB64).replace(/\\$$/, '');
  } catch {
    document.getElementById('signin-msg').textContent =
      'Could not parse CLERK_PUBLISHABLE_KEY.';
    return null;
  }
  if (!frontendApi) {
    document.getElementById('signin-msg').textContent =
      'CLERK_PUBLISHABLE_KEY is malformed.';
    return null;
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://' + frontendApi + '/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.setAttribute('data-clerk-publishable-key', CLERK_PUBLISHABLE_KEY);
    s.onload = () => resolve(window.Clerk);
    s.onerror = () => reject(new Error('Failed to load Clerk SDK'));
    document.head.appendChild(s);
  });
}

async function bootstrapAuth() {
  try {
    const Clerk = await loadClerkSdk();
    if (!Clerk) return;
    await Clerk.load();
    window.__dreddClerk = Clerk;
    if (Clerk.user) {
      onSignedIn(Clerk);
    } else {
      document.getElementById('signin-msg').textContent =
        'Sign in to view the hook container status.';
      const btn = document.getElementById('signin-btn');
      btn.disabled = false;
      btn.textContent = 'Sign in';
      Clerk.addListener(({ user }) => {
        if (user) onSignedIn(Clerk);
      });
    }
  } catch (err) {
    document.getElementById('signin-msg').textContent =
      'Sign-in unavailable: ' + (err && err.message ? err.message : err);
  }
}

function onSignedIn(Clerk) {
  const user = Clerk.user;
  const email =
    (user && user.primaryEmailAddress && user.primaryEmailAddress.emailAddress) ||
    (user && user.emailAddresses && user.emailAddresses[0] && user.emailAddresses[0].emailAddress) ||
    (user && user.id) ||
    'signed in';
  document.getElementById('signed-in-as').textContent = email;
  document.getElementById('signin-overlay').style.display = 'none';
  document.getElementById('main-page').style.display = 'block';
}

function dreddSignIn() {
  const Clerk = window.__dreddClerk;
  if (Clerk) Clerk.openSignIn();
}

function dreddSignOut() {
  const Clerk = window.__dreddClerk;
  if (Clerk) Clerk.signOut().then(() => location.reload());
}

document.addEventListener('DOMContentLoaded', bootstrapAuth);

async function switchMode(next) {
  const select = document.getElementById('mode-select');
  const status = document.getElementById('mode-status');
  const prev = select.dataset.current || select.value;
  status.className = '';
  status.textContent = 'switching…';
  try {
    const resp = await fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    select.className = 'mode-select mode-' + data.mode;
    select.dataset.current = data.mode;
    status.className = 'ok';
    status.textContent = 'switched (' + data.previous + ' → ' + data.mode + ')';
    setTimeout(() => { status.textContent = ''; status.className = ''; }, 4000);
  } catch (err) {
    select.value = prev;
    status.className = 'err';
    status.textContent = 'failed: ' + err.message;
  }
}
document.getElementById('mode-select').dataset.current = ${JSON.stringify(CONFIG.mode)};
</script>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // /health (ALB target-group health check) — never CORSed, never auth'd.
    if (req.method === "GET" && url.pathname === "/health") {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      return json(res, 200, {
        status: "ok",
        version: pkg.version,
        role: "hook",
        config: CONFIG,
        activeSessions: registeredSessions.size,
      });
    }

    // /api/health — same payload, but the dashboard browser polls this
    // cross-origin to render the version + mode badge in its top bar.
    // Apply CORS (and respond to OPTIONS preflight) so it works.
    if (url.pathname === "/api/health") {
      if (applyCors(req, res)) return;
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      return json(res, 200, {
        status: "ok",
        version: pkg.version,
        role: "hook",
        config: CONFIG,
        activeSessions: registeredSessions.size,
        uptimeSeconds: Math.floor(process.uptime()),
        intentMode: INTENT_HISTORY_MODE,
        intentClassifierLlmEnabled: INTENT_CLASSIFIER_LLM_ENABLED,
      });
    }

    // /api/whoami — OIDC discovery. No auth; read-only.
    if (req.method === "GET" && url.pathname === "/api/whoami") {
      const oidcData = req.headers["x-amzn-oidc-data"] as string | undefined;
      const oidcIdentity = req.headers["x-amzn-oidc-identity"] as string | undefined;
      const hasAccessToken = !!req.headers["x-amzn-oidc-accesstoken"];

      let claims: Record<string, unknown> | null = null;
      let decodeError: string | null = null;
      if (oidcData) {
        try {
          const parts = oidcData.split(".");
          if (parts.length === 3) {
            const payload = Buffer.from(parts[1], "base64").toString("utf8");
            claims = JSON.parse(payload);
          } else {
            decodeError = `Expected 3 JWT segments, got ${parts.length}`;
          }
        } catch (err) {
          decodeError = err instanceof Error ? err.message : String(err);
        }
      }

      return json(res, 200, {
        role: "hook",
        authWired: !!oidcData,
        identity: oidcIdentity ?? null,
        hasAccessToken,
        claims,
        decodeError,
        seenHeaders: Object.keys(req.headers)
          .filter((h) => h.toLowerCase().startsWith("x-amzn-"))
          .sort(),
      });
    }

    // /api/data-status — EFS mount probe. Used by the dashboard container
    // to show operators whether /data survives restart. Read-only.
    if (req.method === "GET" && url.pathname === "/api/data-status") {
      const sessionDir = CONFIG.logDir;
      const consoleDir = CONFIG.consoleLogDir;
      const dataDir =
        sessionDir.endsWith("/sessions") ? sessionDir.slice(0, -"/sessions".length) : sessionDir;

      let mounts: Array<{ source: string; target: string; fstype: string; options: string }> = [];
      try {
        mounts = readFileSync("/proc/mounts", "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [source, target, fstype, options] = line.split(/\s+/);
            return { source, target, fstype, options };
          });
      } catch {
        // Not Linux.
      }

      const mountFor = (path: string) => {
        const match = mounts
          .filter((m) => path === m.target || path.startsWith(m.target + "/"))
          .sort((a, b) => b.target.length - a.target.length)[0];
        return match ?? null;
      };

      const describeDir = (dir: string) => {
        if (!existsSync(dir)) {
          return { path: dir, exists: false };
        }
        let files: string[] = [];
        try { files = readdirSync(dir); } catch { files = []; }
        let bytes = 0;
        let newest: { name: string; mtime: string; size: number } | null = null;
        for (const name of files) {
          try {
            const st = statSync(join(dir, name));
            if (!st.isFile()) continue;
            bytes += st.size;
            if (!newest || st.mtimeMs > Date.parse(newest.mtime)) {
              newest = { name, mtime: new Date(st.mtimeMs).toISOString(), size: st.size };
            }
          } catch {}
        }
        return { path: dir, exists: true, fileCount: files.length, totalBytes: bytes, newest };
      };

      const dataMount = mountFor(dataDir);
      return json(res, 200, {
        dataDir,
        sessionDir,
        consoleDir,
        mount: dataMount
          ? {
              source: dataMount.source,
              target: dataMount.target,
              fstype: dataMount.fstype,
              options: dataMount.options,
              persistent:
                dataMount.fstype === "nfs" ||
                dataMount.fstype === "nfs4" ||
                dataMount.fstype === "efs" ||
                !["overlay", "overlay2", "tmpfs", "aufs"].includes(dataMount.fstype),
            }
          : { persistent: false, note: "not a mount point — ephemeral container layer" },
        sessions: describeDir(sessionDir),
        logs: describeDir(consoleDir),
      });
    }

    // /api/feed — cross-origin from the dashboard.
    if (url.pathname === "/api/feed") {
      if (applyCors(req, res)) return;
      if (req.method === "GET") return json(res, 200, feed);
    }

    // /api/mode — cross-origin from the dashboard. Flips trust mode for
    // the whole server in-process. Preflight handled above; POST below.
    if (url.pathname === "/api/mode") {
      if (applyCors(req, res)) return;
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const next = body.mode;
        if (next !== "interactive" && next !== "autonomous" && next !== "learn") {
          return json(res, 400, { error: "mode must be one of: interactive, autonomous, learn" });
        }
        const prev = CONFIG.mode;
        CONFIG.mode = next as TrustMode;
        console.log(`  [MODE] runtime switch: ${prev} → ${next}`);

        // Mode flips are dev-only. The interactive intent stack and the
        // autonomous single-goal model have different invariants — when
        // the operator flips, the safest thing is to drop in-flight
        // intent context for every session this container knows about.
        // The next /intent on each session re-seeds correctly under the
        // new mode. We don't touch session_id sets / tool history.
        const sessions = await tracker.listSessions(500);
        for (const s of sessions) {
          await tracker.setActiveIntents(s.sessionId, []).catch(() => {});
        }
        if (sessions.length > 0) {
          console.log(`  [MODE] cleared intent stacks for ${sessions.length} session(s)`);
        }

        return json(res, 200, { mode: CONFIG.mode, previous: prev });
      }
    }

    // /api/session-mode — cross-origin from the dashboard. Per-session
    // mode override that beats both body.mode and the global CONFIG.mode.
    // Used to rescue a session whose intent stack has locked onto a stale
    // goal: flip it to learn, finish the work, then clear. Unlike
    // /api/mode this does NOT clear any intent stacks — the whole point
    // is to keep the same session running.
    if (url.pathname === "/api/session-mode") {
      if (applyCors(req, res)) return;
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const session_id: unknown = body.session_id;
        if (typeof session_id !== "string") {
          return json(res, 400, { error: "Missing session_id" });
        }
        if (rejectInvalidSessionId(res, session_id)) return;
        const next = body.mode;
        if (next === null) {
          const prev = sessionModeOverride.get(session_id) ?? null;
          sessionModeOverride.delete(session_id);
          console.log(`  [${session_id.substring(0, 8)}] [SESSION-MODE] cleared (was ${prev ?? "none"})`);
          return json(res, 200, { session_id, mode: null, previous: prev });
        }
        if (next !== "interactive" && next !== "autonomous" && next !== "learn") {
          return json(res, 400, { error: "mode must be interactive, autonomous, learn, or null" });
        }
        const prev = sessionModeOverride.get(session_id) ?? null;
        sessionModeOverride.set(session_id, next as TrustMode);
        console.log(`  [${session_id.substring(0, 8)}] [SESSION-MODE] override ${prev ?? "none"} → ${next}`);
        return json(res, 200, { session_id, mode: next, previous: prev });
      }
      if (req.method === "GET") {
        const session_id = url.searchParams.get("session_id") ?? "";
        if (!session_id || rejectInvalidSessionId(res, session_id)) return;
        return json(res, 200, {
          session_id,
          mode: sessionModeOverride.get(session_id) ?? null,
          global_mode: CONFIG.mode,
        });
      }
    }

    // /api/session-intent-mode — per-session override of the
    // INTENT_HISTORY_MODE flag. Same shape as /api/session-mode but
    // for the history-active rollout. POST {session_id, mode:
    // "legacy"|"history-active"|null} to set/clear; GET ?session_id
    // to read. Lets us A/B-test the new classifier on individual
    // sessions in a sandbox while production stays on legacy.
    if (url.pathname === "/api/session-intent-mode") {
      if (applyCors(req, res)) return;
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const session_id: unknown = body.session_id;
        if (typeof session_id !== "string") {
          return json(res, 400, { error: "Missing session_id" });
        }
        if (rejectInvalidSessionId(res, session_id)) return;
        const next = body.mode;
        if (next === null) {
          const prev = sessionIntentModeOverride.get(session_id) ?? null;
          sessionIntentModeOverride.delete(session_id);
          console.log(`  [${session_id.substring(0, 8)}] [SESSION-INTENT-MODE] cleared (was ${prev ?? "none"})`);
          return json(res, 200, { session_id, intent_mode: null, previous: prev });
        }
        if (next !== "legacy" && next !== "history-active") {
          return json(res, 400, { error: "intent_mode must be legacy, history-active, or null" });
        }
        const prev = sessionIntentModeOverride.get(session_id) ?? null;
        sessionIntentModeOverride.set(session_id, next);
        console.log(`  [${session_id.substring(0, 8)}] [SESSION-INTENT-MODE] override ${prev ?? "none"} → ${next}`);
        return json(res, 200, { session_id, intent_mode: next, previous: prev });
      }
      if (req.method === "GET") {
        const session_id = url.searchParams.get("session_id") ?? "";
        if (!session_id || rejectInvalidSessionId(res, session_id)) return;
        return json(res, 200, {
          session_id,
          intent_mode: sessionIntentModeOverride.get(session_id) ?? null,
          global_intent_mode: INTENT_HISTORY_MODE,
        });
      }
    }

    // /api/session-modes — bulk read of all per-session overrides. The
    // dashboard's sessions table calls this once per refresh to render
    // the per-row mode dropdown.
    if (url.pathname === "/api/session-modes") {
      if (applyCors(req, res)) return;
      if (req.method === "GET") {
        const overrides: Record<string, TrustMode> = {};
        for (const [sid, m] of sessionModeOverride.entries()) overrides[sid] = m;
        return json(res, 200, { overrides, global_mode: CONFIG.mode });
      }
    }

    // /screen — PromptArmor head-to-head endpoint. Wraps
    // PromptArmorBaseline.screen() so the AgentDojo and MT-AgentRisk
    // Python runners can call it via requests.post without re-implementing
    // the detector pass in Python. Locked-down: model allow-list (only
    // the 5 backends from the test plan), content size cap, no
    // SessionTracker side-effects. This is a side-channel for benchmarks,
    // not part of the Dredd hot path.
    if (url.pathname === "/screen") {
      if (applyCors(req, res)) return;
      if (req.method === "POST") return await handleScreen(req, res);
    }

    // Debug/test helper — exposes a session's live context by id. No auth;
    // returns only the in-memory slice. Keep simple — dashboard has
    // /api/session-log/:id for the full shape.
    if (req.method === "GET" && url.pathname.startsWith("/session/")) {
      const id = url.pathname.split("/session/")[1];
      return await handleSessionGet(res, id);
    }

    // ------ Hook events -------------------------------------------------
    if (req.method === "POST" && url.pathname === "/intent")   return await handleIntent(req, res);
    if (req.method === "POST" && url.pathname === "/register") return await handleRegister(req, res);
    if (req.method === "POST" && url.pathname === "/evaluate") return await handleEvaluate(req, res);
    if (req.method === "POST" && url.pathname === "/track")    return await handleTrack(req, res);
    if (req.method === "POST" && url.pathname === "/end")      return await handleEnd(req, res);
    if (req.method === "POST" && url.pathname === "/stop")     return await handleStop(req, res);
    if (req.method === "POST" && url.pathname === "/pivot")    return await handlePivot(req, res);
    if (req.method === "POST" && url.pathname === "/compact")  return await handleCompact(req, res);
    if (req.method === "POST" && url.pathname === "/notification") return await handleNotification(req, res);

    if (req.method === "GET" && url.pathname.startsWith("/api/notifications/")) {
      const id = url.pathname.split("/api/notifications/")[1];
      return handleNotificationsGet(res, id);
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      console.warn(`[413] ${req.method} ${url.pathname}: body exceeded ${err.bodyLimit} bytes`);
      return json(res, 413, { error: "Request body too large" });
    }
    if (err instanceof SyntaxError) {
      console.warn(`[400] ${req.method} ${url.pathname}: invalid JSON: ${err.message}`);
      return json(res, 400, { error: "Invalid JSON body" });
    }
    console.error(`[ERROR] ${req.method} ${url.pathname}:`, err);
    json(res, 500, { error: "Internal server error" });
  }
});

server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 5_000;

// =========================================================================
// Startup
// =========================================================================
export async function main() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  console.log("█".repeat(50));
  console.log(`  JUDGE AI DREDD — HOOK Server v${pkg.version}`);
  console.log("█".repeat(50));

  if (process.env.DREDD_SKIP_PREFLIGHT === "1") {
    console.warn("  [PREFLIGHT] skipped (DREDD_SKIP_PREFLIGHT=1) — test mode");
  } else {
    await interceptor.preflight();
  }
  console.log(`  Mode:            ${CONFIG.mode}`);
  console.log(`  Embedding model: ${CONFIG.embeddingModel}`);
  console.log(`  Judge backend:   ${CONFIG.judgeBackend}`);
  console.log(`  Judge model:     ${CONFIG.judgeModel}`);
  console.log(`  Judge prompt:    ${CONFIG.hardened || "standard"}`);
  if (CONFIG.judgeEffort) console.log(`  Judge effort:    ${CONFIG.judgeEffort}`);
  console.log(`  Thresholds:      review=${CONFIG.reviewThreshold}, deny=${CONFIG.denyThreshold}`);
  console.log(`  Hijack lock:     ${CONFIG.hijackThreshold} strike${CONFIG.hijackThreshold === 1 ? "" : "s"} (autonomous mode only)`);
  console.log(`  Session logs:    ${CONFIG.logDir}`);
  console.log(`  Console logs:    ${CONFIG.consoleLogDir}`);
  console.log(`  Dashboard CORS:  ${DASHBOARD_ORIGIN || "(disabled — DREDD_DASHBOARD_ORIGIN unset)"}`);
  console.log(`  Intent model:    ${INTENT_HISTORY_MODE}` +
    (INTENT_HISTORY_MODE === "history-active"
      ? ` (LLM classifier ${INTENT_CLASSIFIER_LLM_ENABLED ? "ON" : "OFF"})`
      : ` (legacy single-stack — sub-task / replacement / revisit kinds disabled)`));

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  Listening on http://0.0.0.0:${PORT}`);
    console.log(`\n  Endpoints:`);
    console.log(`    POST /intent    — UserPromptSubmit (register intent)`);
    console.log(`    POST /evaluate  — PreToolUse (evaluate tool call)`);
    console.log(`    POST /track     — PostToolUse (record file/env state)`);
    console.log(`    POST /end       — Stop (write log, cleanup)`);
    console.log(`    POST /pivot     — explicit direction change`);
    console.log(`    POST /compact   — context compaction notification`);
    console.log(`    POST /notification — Notification hook (friction signal)`);
    console.log(`    POST /screen    — PromptArmor detector (benchmark side-channel)`);
    console.log(`    GET  /api/notifications/:id — per-session friction counter`);
    console.log(`    POST /api/mode  — runtime trust-mode switch`);
    console.log(`    POST /api/session-mode — per-session mode override`);
    console.log(`    GET  /api/session-modes — bulk read of overrides`);
    console.log(`    GET  /health    — health check + version`);
    console.log(`    GET  /api/feed  — live event ring buffer (cross-origin)`);
    console.log("█".repeat(50));
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully");
    server.close(async () => {
      // Drain pending log lines to disk before exiting so the last
      // few seconds of activity (the SIGTERM, the close events) make
      // it into the daily file.
      await flushLogs();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  });
}
