/**
 * Fail-closed judge + judge-health accounting.
 *
 * WHY. `failVerdictFor` splits two failure modes. A CODE BUG (TypeError etc.)
 * sets `internalError`, and `pretool-interceptor.ts` computes
 * `allowed = verdict !== "hijacked" && !internalError`, so it fails closed. An
 * AVAILABILITY error (backend unreachable, timeout, throttle) returns plain
 * `drifting`, which is an ALLOWED verdict — the call goes through unjudged.
 *
 * That second branch is defensible when the backend is Bedrock: outages are
 * rare, brief, and somebody else's, and hard-failing would brick every agent
 * during an AWS blip. It is not defensible for the self-hosted deployment
 * (docs/plan-selfhost-studio-2026-08-26.md), where the judge is a process on a
 * box you own. Stop Ollama, evict the model for idleness, or merely saturate
 * it, and every tool call sails through with nothing surfacing it — an attacker
 * who can stall inference has disabled the defence silently.
 *
 * DREDD_JUDGE_FAIL_CLOSED routes availability errors through the SAME
 * enforcement path as an internal error, so there is no second decision path to
 * reason about. Trust mode still decides what "not allowed" MEANS: interactive
 * asks the user, autonomous denies. That is what makes it safe to default on
 * for a self-hosted box while leaving the AWS stack's behaviour untouched.
 *
 * The health half exists because `interceptor.preflight()` proves the judge
 * worked at STARTUP and nothing checks it again. "The judge stopped working
 * three days ago" should not be discoverable only by reading session logs.
 *
 * NOTE ON THE ENV VAR: intent-judge.ts reads DREDD_JUDGE_FAIL_CLOSED once at
 * module load, so each mode needs a fresh module instance. We use a cache-
 * busting import query rather than mutating a module-level export, so what is
 * tested is the real load-time path a container actually takes.
 *
 * Run: npx tsx hooks/tests/test_judge_fail_closed.ts
 */

process.env.OLLAMA_HOST = "http://127.0.0.1:9"; // nothing here; nothing should call it

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++) : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

/** Load a fresh copy of intent-judge with the flag in a given state. */
async function loadJudge(failClosed: boolean, bust: string) {
  if (failClosed) process.env.DREDD_JUDGE_FAIL_CLOSED = "true";
  else delete process.env.DREDD_JUDGE_FAIL_CLOSED;
  return await import(`../../src/intent-judge.js?flag=${bust}`);
}

/** Mirrors the interceptor's enforcement expression verbatim. If this drifts
 *  from pretool-interceptor.ts the test is measuring nothing. */
const allowedBy = (v: { verdict: string; internalError?: boolean }) =>
  v.verdict !== "hijacked" && !v.internalError;

async function main() {
  // ---------------------------------------------------------------------
  section("flag OFF — historical behaviour preserved");
  // ---------------------------------------------------------------------
  {
    const j = await loadJudge(false, "off");
    ok("module reports the flag off", j.JUDGE_FAIL_CLOSED === false);

    const outage = j.failVerdictFor(new Error("connect ECONNREFUSED 127.0.0.1:11434"), 12);
    ok("availability error → drifting", outage.verdict === "drifting");
    ok("...not marked internalError", !outage.internalError);
    ok("...and is ALLOWED (fail-soft)", allowedBy(outage) === true);
    ok("...reason says fail-soft", /fail-soft/.test(outage.reasoning));
    ok("...duration threaded through", outage.durationMs === 12);

    // A code bug must fail closed even with the flag off — that behaviour
    // predates this flag and must not be coupled to it.
    const bug = j.failVerdictFor(new TypeError("Cannot read properties of undefined"), 3);
    ok("code bug still fails closed with the flag OFF", allowedBy(bug) === false);
    ok("...marked internalError", bug.internalError === true);
  }

  // ---------------------------------------------------------------------
  section("flag ON — an unavailable judge no longer allows");
  // ---------------------------------------------------------------------
  {
    const j = await loadJudge(true, "on");
    ok("module reports the flag on", j.JUDGE_FAIL_CLOSED === true);

    const outage = j.failVerdictFor(new Error("connect ECONNREFUSED 127.0.0.1:11434"), 9);
    ok("availability error is NOT allowed", allowedBy(outage) === false);
    ok("...via internalError, the existing enforcement path", outage.internalError === true);
    ok("...reason names the cause as unavailability, not a bug", /fail-closed/.test(outage.reasoning) && /unavailable/i.test(outage.reasoning));
    ok("...verdict stays 'drifting', so it is NOT a hijack strike", outage.verdict === "drifting");
    ok("...confidence 0", outage.confidence === 0);

    // Timeouts and throttles are the same class and must behave the same.
    for (const [label, err] of [
      ["timeout", new Error("Request timed out after 60000ms")],
      ["throttle", new Error("ThrottlingException: Too many requests")],
      ["non-Error throw", "backend exploded"],
    ] as Array<[string, unknown]>) {
      ok(`${label} also fails closed`, allowedBy(j.failVerdictFor(err)) === false);
    }

    const bug = j.failVerdictFor(new TypeError("boom"));
    ok("code bug still fails closed (unchanged)", allowedBy(bug) === false);
    ok("...and is still labelled an internal bug, not unavailability", /internal error/i.test(bug.reasoning));
  }

  // ---------------------------------------------------------------------
  section("verdict is never silently escalated to hijacked");
  // ---------------------------------------------------------------------
  {
    // A hijack verdict increments the session's strike counter and can
    // session-lock. An OUTAGE must never do that — it is not evidence of an
    // attack, and locking a session because Ollama restarted would be a
    // self-inflicted denial of service.
    const j = await loadJudge(true, "strike");
    const v = j.failVerdictFor(new Error("ECONNREFUSED"));
    ok("outage verdict is not 'hijacked'", v.verdict !== "hijacked");
  }

  // ---------------------------------------------------------------------
  section("judge health — observed, not probed");
  // ---------------------------------------------------------------------
  {
    const h = await import("../../src/judge-health.js");
    h.resetJudgeHealth();

    ok("no traffic → 'unknown', not 'ok'", h.getJudgeHealth().status === "unknown");
    ok("...and no backend claimed", h.getJudgeHealth().backend === null);

    h.recordJudgeOutcome(true, "ollama", "qwen3.6");
    let s = h.getJudgeHealth();
    ok("one success → ok", s.status === "ok");
    ok("...backend and model recorded", s.backend === "ollama" && s.model === "qwen3.6");
    ok("...lastSuccessAt set", !!s.lastSuccessAt);
    ok("...secondsSinceSuccess is a number", typeof s.secondsSinceSuccess === "number");

    h.recordJudgeOutcome(false, "ollama", "qwen3.6", "ECONNREFUSED\nstack line");
    s = h.getJudgeHealth();
    ok("one failure after success → degraded, not down", s.status === "degraded");
    ok("...error captured, first line only", s.lastError === "ECONNREFUSED");
    ok("...consecutiveFailures = 1", s.consecutiveFailures === 1);

    h.recordJudgeOutcome(false, "ollama", "qwen3.6", "ECONNREFUSED");
    ok("two consecutive failures still 'degraded'", h.getJudgeHealth().status === "degraded");
    h.recordJudgeOutcome(false, "ollama", "qwen3.6", "ECONNREFUSED");
    ok("three consecutive failures → down", h.getJudgeHealth().status === "down");

    h.recordJudgeOutcome(true, "ollama", "qwen3.6");
    s = h.getJudgeHealth();
    ok("a success clears the streak", s.status === "ok" && s.consecutiveFailures === 0);
    ok("...but the historical totals persist", s.totalFailures === 3 && s.totalCalls === 5);
    ok("...and lastError is retained for diagnosis", s.lastError === "ECONNREFUSED");

    // Must never throw — health accounting cannot break a verdict.
    let threw = false;
    try {
      h.recordJudgeOutcome(false, "ollama", "qwen3.6", undefined);
    } catch { threw = true; }
    ok("recordJudgeOutcome tolerates a missing error string", !threw);
  }

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
