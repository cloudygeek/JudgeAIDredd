/**
 * Shared module-level state for the hook-side route handlers.
 *
 * When the handlers lived in `server-hook.ts`, these were just file-
 * scope `const`s. After the per-handler split each handler file imports
 * the bits it needs from here — keeps the per-handler imports honest
 * about what they depend on while preserving the single-instance
 * semantics (one IntentClassifier, one mode-override Map per process).
 */

import { readFileSync } from "node:fs";
import { CONFIG, type TrustMode } from "../server-core.js";
import { IntentClassifier } from "../intent-classifier.js";

/** History-active model rollout — top-level flag gating the new
 *  intent-classifier behaviour. Layered with INTENT_CLASSIFIER_LLM_ENABLED
 *  so we can stage the rollout:
 *
 *   legacy (default):
 *     - Schema layer always runs (Steps 1-2 are behaviour-equivalent;
 *       existing call sites use getActiveIntents/setActiveIntents and
 *       see exactly the legacy stack).
 *     - The new sub-task / replacement / revisit kinds DO NOT fire.
 *     - Judge sees the legacy plain numbered list (no [annotation]
 *       suffixes).
 *     - The async LLM classifier never starts.
 *
 *   history-active:
 *     - The Step-3 embedding classifier produces the new kinds.
 *     - Judge prompt renders parent/child + replacement annotations.
 *     - LLM classifier may run if INTENT_CLASSIFIER_LLM_ENABLED is
 *       also true.
 *
 * Step-6 staged rollout: enable history-active first (cost-neutral —
 * just smarter classification + richer judge prompts). Once telemetry
 * confirms the classification rates look sensible, flip
 * INTENT_CLASSIFIER_LLM_ENABLED to add the LLM safety net. */
export const INTENT_HISTORY_MODE: "legacy" | "history-active" =
  process.env.INTENT_HISTORY_MODE === "history-active" ? "history-active" : "legacy";

export const INTENT_CLASSIFIER_LLM_ENABLED =
  process.env.INTENT_CLASSIFIER_LLM_ENABLED === "true"
  && INTENT_HISTORY_MODE === "history-active";

/**
 * The classifier follows the deployment's backend unless explicitly overridden.
 *
 * It used to default to Bedrock independently of `CONFIG.judgeBackend`, which
 * made `BACKEND=ollama` a half-measure: the judge went local, the classifier
 * silently kept calling Bedrock, and on a deployment with no AWS credentials
 * every classify() failed. That failure is quiet by design — classify()
 * returns null on any error and the caller falls back to embedding-only intent
 * tracking — so a fully-local deployment would have run indefinitely with the
 * LLM classifier dead and nothing in the logs but a warn line.
 *
 * INTENT_CLASSIFIER_BACKEND / INTENT_CLASSIFIER_MODEL still override, for
 * running a cheap local classifier alongside a Bedrock judge or vice versa.
 */
const classifierBackend =
  (process.env.INTENT_CLASSIFIER_BACKEND as "bedrock" | "ollama" | undefined) ??
  CONFIG.judgeBackend;
const classifierModel =
  process.env.INTENT_CLASSIFIER_MODEL ??
  (classifierBackend === "bedrock" ? "eu.anthropic.claude-sonnet-4-6" : CONFIG.judgeModel);

export const intentClassifier = new IntentClassifier(classifierBackend, classifierModel);

/** How long /evaluate waits for an in-flight classifier verdict
 *  before falling back to the existing active state. Cap chosen to
 *  stay below typical agent-response latency so it's hidden in
 *  normal flow. */
export const CLASSIFIER_EVALUATE_WAIT_MS = 750;

/** Build version, surfaced in every permissionDecisionReason so users
 *  can tell which deployment produced an error. Read once at module
 *  load — package.json is baked into the image. */
export const PKG_VERSION: string = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ).version as string;
  } catch {
    return "unknown";
  }
})();

export const DREDD_TAG = `Judge AI Dredd [v${PKG_VERSION}]`;

/** Per-session trust-mode override. Set via POST /api/session-mode from
 *  the dashboard. Beats body.mode and CONFIG.mode for that one session —
 *  used to rescue stuck sessions where the LLM stack classifier has
 *  locked onto a stale goal and every command trips drift-deny. In-
 *  memory; cleared on container restart. ALB stickiness keeps the
 *  session pinned to one task so the override stays effective for the
 *  session's lifetime. */
export const sessionModeOverride = new Map<string, TrustMode>();

export function effectiveMode(session_id: string, bodyMode: unknown): TrustMode {
  const override = sessionModeOverride.get(session_id);
  if (override) return override;
  return ((bodyMode as TrustMode | undefined) ?? CONFIG.mode);
}

/** Per-session intent-history-model override. Same shape as
 *  sessionModeOverride but for the history-active rollout — lets a
 *  sandbox A/B-test history-active on one session while production
 *  stays on legacy. Set via POST /api/session-intent-mode. */
export const sessionIntentModeOverride = new Map<string, "legacy" | "history-active">();

export function effectiveIntentHistoryMode(session_id: string): boolean {
  const override = sessionIntentModeOverride.get(session_id);
  if (override) return override === "history-active";
  return INTENT_HISTORY_MODE === "history-active";
}
