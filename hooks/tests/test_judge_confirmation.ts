/**
 * Hijack confirmation — re-sampling a `hijacked` verdict before acting on it.
 *
 * WHY IT EXISTS. Measured on the live store 2026-09-02: 45 real judge-deny
 * events, replayed 5x against the same judge with their original task and
 * reconstructed tool history — only 6 (13%) reproduced as a stable deny, 16
 * (36%) flipped, 23 (51%) never reproduced. Meanwhile every true positive in
 * the hard corpus was stable (24/24) and the dominant FP class flips at
 * p=0.20 (6/30). Instability is the discriminator.
 *
 * WHAT THIS FILE GUARDS. The feature can only ever be as strict as the
 * behaviour it replaces, so the failure modes matter more than the happy path:
 *  - log-only must NOT change a verdict (that is the whole soak plan);
 *  - a re-sample that THROWS must count as agreeing, never as a release;
 *  - internalError must never be re-sampled away — it fails closed by design;
 *  - a non-hijacked verdict must not trigger extra calls (cost).
 *
 * Flags are read at module load, so each mode needs a fresh module instance;
 * cache-busting import queries give that without mutating exports.
 */
const c = { green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++) : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

async function loadJudge(env: Record<string, string | undefined>, bust: string) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return await import(`../../src/intent-judge.js?confirm=${bust}`);
}

/** A judge whose single-sample verdicts are scripted. Records call count. */
function scripted(mod: any, verdicts: string[], opts: { internalError?: boolean } = {}) {
  const j = new mod.IntentJudge("stub", "ollama");
  let i = 0;
  const calls = { n: 0 };
  (j as any).evaluateOnce = async () => {
    calls.n++;
    const v = verdicts[Math.min(i++, verdicts.length - 1)];
    if (v === "THROW") throw new Error("backend blew up");
    return { verdict: v, confidence: 0.9, reasoning: "stub", durationMs: 1, ...opts };
  };
  return { j, calls };
}

async function main() {
  // -------------------------------------------------------------------
  section("flag OFF — untouched behaviour");
  // -------------------------------------------------------------------
  {
    const m = await loadJudge({ DREDD_JUDGE_CONFIRM_ENABLED: undefined, DREDD_JUDGE_CONFIRM_ENFORCE: undefined }, "off");
    ok("module reports the flag off", m.JUDGE_CONFIRM_ENABLED === false);
    const { j, calls } = scripted(m, ["hijacked", "consistent", "consistent"]);
    const r = await j.evaluate("task", [], "action");
    ok("hijacked stays hijacked", r.verdict === "hijacked");
    ok("...exactly one judge call", calls.n === 1);
    ok("...no confirmation recorded", r.confirmation === undefined);
  }

  // -------------------------------------------------------------------
  section("flag ON, log-only (the soak default)");
  // -------------------------------------------------------------------
  {
    const m = await loadJudge({ DREDD_JUDGE_CONFIRM_ENABLED: "true", DREDD_JUDGE_CONFIRM_ENFORCE: undefined }, "logonly");
    ok("enabled, not enforcing", m.JUDGE_CONFIRM_ENABLED === true && m.JUDGE_CONFIRM_ENFORCE === false);

    // Disagreement: the case the feature is FOR — must still deny in log-only.
    const a = scripted(m, ["hijacked", "consistent"]);
    const ra = await a.j.evaluate("t", [], "x");
    ok("disagreement is RECORDED", ra.confirmation?.wouldRelease === true);
    ok("...but the verdict is UNCHANGED (log-only)", ra.verdict === "hijacked");
    ok("...marked as not enforced", ra.confirmation?.enforced === false);
    ok("...short-circuits on first disagreement", a.calls.n === 2);

    // Unanimous: a real attack should reproduce.
    const b = scripted(m, ["hijacked", "hijacked", "hijacked"]);
    const rb = await b.j.evaluate("t", [], "x");
    ok("unanimous hijack holds", rb.verdict === "hijacked" && rb.confirmation?.wouldRelease === false);
    ok("...took the full rep count", b.calls.n === 3);

    // Cost guard: a clean verdict must not pay for re-sampling.
    const cc = scripted(m, ["consistent"]);
    const rc = await cc.j.evaluate("t", [], "x");
    ok("consistent verdict is not re-sampled", cc.calls.n === 1 && rc.confirmation === undefined);

    // Fail-safe: a throwing re-sample must not release.
    const d = scripted(m, ["hijacked", "THROW", "THROW"]);
    const rd = await d.j.evaluate("t", [], "x");
    ok("a throwing re-sample counts as AGREEING", rd.confirmation?.wouldRelease === false);
    ok("...so the call stays denied", rd.verdict === "hijacked");

    // internalError fails closed by design and must not be re-sampled away.
    const e = scripted(m, ["hijacked", "consistent"], { internalError: true });
    const re = await e.j.evaluate("t", [], "x");
    ok("internalError is never re-sampled", e.calls.n === 1 && re.verdict === "hijacked");
  }

  // -------------------------------------------------------------------
  section("flag ON, ENFORCING");
  // -------------------------------------------------------------------
  {
    const m = await loadJudge({ DREDD_JUDGE_CONFIRM_ENABLED: "true", DREDD_JUDGE_CONFIRM_ENFORCE: "true" }, "enforce");
    ok("enforcing", m.JUDGE_CONFIRM_ENFORCE === true);

    const a = scripted(m, ["hijacked", "consistent"]);
    const ra = await a.j.evaluate("t", [], "x");
    ok("disagreement RELEASES the call", ra.verdict !== "hijacked");
    ok("...as drifting, not consistent (anchor still fires)", ra.verdict === "drifting");
    ok("...reasoning explains the release and keeps the original", 
      /did not reproduce/.test(ra.reasoning) && /Original:/.test(ra.reasoning));

    const b = scripted(m, ["hijacked", "hijacked", "hijacked"]);
    const rb = await b.j.evaluate("t", [], "x");
    ok("unanimous hijack still DENIES when enforcing", rb.verdict === "hijacked");

    const d = scripted(m, ["hijacked", "THROW", "THROW"]);
    const rd = await d.j.evaluate("t", [], "x");
    ok("a throwing re-sample cannot release even when enforcing", rd.verdict === "hijacked");
  }

  // -------------------------------------------------------------------
  section("rep count is bounded");
  // -------------------------------------------------------------------
  {
    const m = await loadJudge({ DREDD_JUDGE_CONFIRM_ENABLED: "true", DREDD_JUDGE_CONFIRM_REPS: "99" }, "reps-hi");
    ok("clamped to 10", m.JUDGE_CONFIRM_REPS === 10);
    const m2 = await loadJudge({ DREDD_JUDGE_CONFIRM_ENABLED: "true", DREDD_JUDGE_CONFIRM_REPS: "1" }, "reps-lo");
    ok("floor of 2 (1 rep would be a no-op)", m2.JUDGE_CONFIRM_REPS === 2);
    const m3 = await loadJudge({ DREDD_JUDGE_CONFIRM_ENABLED: "true", DREDD_JUDGE_CONFIRM_REPS: "nonsense" }, "reps-bad");
    ok("garbage falls back to 3", m3.JUDGE_CONFIRM_REPS === 3);
  }

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
