/**
 * judge-health.ts — is the judge backend actually answering?
 *
 * WHY THIS EXISTS. `interceptor.preflight()` proves the judge works at STARTUP
 * and nothing checks it again. On Fargate that was tolerable: Bedrock is
 * somebody else's uptime problem, and a task that could not reach it usually
 * failed loudly at boot. Self-hosted, the judge is a process on a box you own —
 * it can be stopped, evicted for idleness, wedged, or merely saturated hours
 * after a clean start, and with the historical fail-soft behaviour every tool
 * call then sails through unjudged. "The judge stopped working three days ago"
 * should not be discoverable only by reading session logs.
 *
 * OBSERVED, NOT PROBED. Health is derived from real judge traffic rather than
 * by pinging the model on each /health poll. A health check that ran inference
 * would burn GPU (or Bedrock spend) on a timer, and — worse — would report a
 * backend as healthy on the strength of a trivial synthetic prompt while real
 * judge calls were timing out on their much larger ones. What matters is
 * whether the calls Dredd actually makes are succeeding.
 *
 * The cost of that choice: on an idle server the status is `unknown`, because
 * no traffic means no evidence. That is honest — it is not `ok`.
 */

export type JudgeHealthStatus = "ok" | "degraded" | "down" | "unknown";

export interface JudgeHealth {
  status: JudgeHealthStatus;
  backend: string | null;
  model: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  /** Seconds since the last successful judge call, or null if never. */
  secondsSinceSuccess: number | null;
}

/** Consecutive failures before the backend is called `down` rather than
 *  `degraded`. Two is deliberate: one failure is a blip (a timeout, a
 *  throttle), a run of them is an outage. */
const DOWN_AFTER_CONSECUTIVE_FAILURES = 3;

const state = {
  backend: null as string | null,
  model: null as string | null,
  lastSuccessAt: null as string | null,
  lastFailureAt: null as string | null,
  lastError: null as string | null,
  consecutiveFailures: 0,
  totalCalls: 0,
  totalFailures: 0,
};

/** Record one judge outcome. Called from IntentJudge.evaluate on both paths.
 *  Must never throw — health accounting cannot be allowed to break a verdict. */
export function recordJudgeOutcome(
  ok: boolean,
  backend: string,
  model: string,
  error?: string,
): void {
  try {
    state.backend = backend;
    state.model = model;
    state.totalCalls += 1;
    if (ok) {
      state.lastSuccessAt = new Date().toISOString();
      state.consecutiveFailures = 0;
      return;
    }
    state.totalFailures += 1;
    state.consecutiveFailures += 1;
    state.lastFailureAt = new Date().toISOString();
    state.lastError = (error ?? "unknown").split("\n")[0].slice(0, 300);
  } catch {
    /* health accounting is best-effort by design */
  }
}

export function getJudgeHealth(): JudgeHealth {
  const secondsSinceSuccess = state.lastSuccessAt
    ? Math.floor((Date.now() - Date.parse(state.lastSuccessAt)) / 1000)
    : null;

  let status: JudgeHealthStatus;
  if (state.totalCalls === 0) {
    status = "unknown"; // no traffic yet — absence of evidence, not health
  } else if (state.consecutiveFailures >= DOWN_AFTER_CONSECUTIVE_FAILURES) {
    status = "down";
  } else if (state.consecutiveFailures > 0) {
    status = "degraded";
  } else {
    status = "ok";
  }

  return {
    status,
    backend: state.backend,
    model: state.model,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    lastError: state.lastError,
    consecutiveFailures: state.consecutiveFailures,
    totalCalls: state.totalCalls,
    totalFailures: state.totalFailures,
    secondsSinceSuccess,
  };
}

/** Test seam. */
export function resetJudgeHealth(): void {
  state.backend = null;
  state.model = null;
  state.lastSuccessAt = null;
  state.lastFailureAt = null;
  state.lastError = null;
  state.consecutiveFailures = 0;
  state.totalCalls = 0;
  state.totalFailures = 0;
}
