/**
 * bedrock-metrics — accumulator unit tests.
 *
 * Validates per-caller stat math and the derived cost / cache-hit rate
 * fields without hitting Bedrock. The point of the module is to give
 * us operator visibility on real cache-hit rates — these tests just
 * make sure the arithmetic stays correct as we add fields.
 *
 * Run: npx tsx hooks/tests/test_bedrock_metrics.ts
 */

import {
  recordBedrockCall,
  getBedrockMetrics,
  resetBedrockMetrics,
} from "../../src/bedrock-metrics.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function main() {
  section("Empty state");
  resetBedrockMetrics();
  const empty = getBedrockMetrics();
  empty.totals.calls === 0 ? pass("totals.calls = 0") : fail(`got ${empty.totals.calls}`);
  Object.keys(empty.perCaller).length === 0 ? pass("perCaller empty") : fail("expected empty perCaller");

  section("Single call — no cache");
  resetBedrockMetrics();
  recordBedrockCall("judge", { inputTokens: 4000, outputTokens: 50, durationMs: 1800 });
  const s1 = getBedrockMetrics();
  s1.perCaller.judge.calls === 1 ? pass("judge calls = 1") : fail(`got ${s1.perCaller.judge.calls}`);
  s1.perCaller.judge.cacheHits === 0 ? pass("cacheHits = 0 on no-cache call") : fail("unexpected hits");
  s1.perCaller.judge.totalInputTokens === 4000 ? pass("input tokens summed") : fail("input mismatch");
  approx(s1.perCaller.judge.cacheHitRate, 0) ? pass("hitRate = 0") : fail(`got ${s1.perCaller.judge.cacheHitRate}`);
  approx(s1.perCaller.judge.cachedTokenShare, 0) ? pass("cachedTokenShare = 0") : fail("unexpected share");

  // Cost = 4000 input × $3.30/M + 50 output × $16.50/M
  //      = 0.0132 + 0.000825 = 0.014025
  const expected1 = (4000 / 1e6) * 3.30 + (50 / 1e6) * 16.50;
  approx(s1.perCaller.judge.estimatedCostUsd, expected1, 1e-6)
    ? pass(`cost ${s1.perCaller.judge.estimatedCostUsd.toFixed(6)} matches uncached calc`)
    : fail(`got ${s1.perCaller.judge.estimatedCostUsd} expected ${expected1}`);

  // NOTE ON FIXTURE SHAPE. Bedrock's three input counters are DISJOINT —
  // `totalTokens == inputTokens + cacheRead + cacheWrite + outputTokens`,
  // verified against eu.anthropic.claude-sonnet-4-6 (a 2,409-token cached
  // prefix returns inputTokens=13, cacheWrite=2409, totalTokens=2426). So a
  // 4,000-token prompt with 3,500 cached is recorded as inputTokens=500,
  // cacheRead=3500 — NOT inputTokens=4000. These fixtures previously passed
  // 4000 alongside cacheRead 3500 and expected the code to subtract, which is
  // how the meter shipped billing zero full-rate input for months.
  section("Cache hit — discount applied");
  resetBedrockMetrics();
  recordBedrockCall("judge", {
    inputTokens: 500, // full-rate remainder
    outputTokens: 50,
    cacheReadInputTokens: 3500, // 87.5% of the 4,000-token prompt
    durationMs: 1800,
  });
  const s2 = getBedrockMetrics();
  s2.perCaller.judge.cacheHits === 1 ? pass("cache hit counted") : fail(`got ${s2.perCaller.judge.cacheHits}`);
  approx(s2.perCaller.judge.cacheHitRate, 1) ? pass("hitRate = 1.0") : fail("hitRate wrong");
  approx(s2.perCaller.judge.cachedTokenShare, 3500 / 4000)
    ? pass(`cachedTokenShare = ${s2.perCaller.judge.cachedTokenShare.toFixed(3)} of the whole prompt`)
    : fail(`got ${s2.perCaller.judge.cachedTokenShare}`);
  approx(s2.perCaller.judge.avgInputTokens, 4000)
    ? pass("avgInputTokens reports the whole prompt (4000), not just the full-rate part")
    : fail(`got ${s2.perCaller.judge.avgInputTokens}`);

  // Cost = 500 × $3.30/M + 3500 × $0.33/M + 50 × $16.50/M
  //      = 0.00165 + 0.001155 + 0.000825 = 0.00363
  const expected2 =
    (500 / 1e6) * 3.30 +
    (3500 / 1e6) * 0.33 +
    (50 / 1e6) * 16.50;
  approx(s2.perCaller.judge.estimatedCostUsd, expected2, 1e-6)
    ? pass(`cost ${s2.perCaller.judge.estimatedCostUsd.toFixed(6)} matches cached calc`)
    : fail(`got ${s2.perCaller.judge.estimatedCostUsd} expected ${expected2}`);

  // Cache should make this dramatically cheaper than the uncached case.
  s2.perCaller.judge.estimatedCostUsd < expected1 * 0.5
    ? pass("cached cost < 50% of uncached")
    : fail(`cached cost ${s2.perCaller.judge.estimatedCostUsd} not much lower than uncached ${expected1}`);

  // ---- REGRESSION GUARD -------------------------------------------------
  // The judge's real per-call shape: a ~1.8K cached system prompt against a
  // few-hundred-token user prompt, i.e. cacheRead > inputTokens. The old code
  // computed max(0, input - cacheRead - cacheWrite) and so billed ZERO tokens
  // at full input rate here. Nothing in this suite covered that shape, which
  // is why a meter that read ~29% low at production prompt sizes passed 24/24.
  // Numbers below are a verbatim call from the 2026-08-26 three-way eval.
  section("REGRESSION — cacheRead exceeds inputTokens (the judge's real shape)");
  resetBedrockMetrics();
  recordBedrockCall("judge", {
    inputTokens: 218,
    outputTokens: 69,
    cacheReadInputTokens: 1805,
    durationMs: 2900,
  });
  const sReg = getBedrockMetrics();
  const expectedReg = (218 / 1e6) * 3.30 + (1805 / 1e6) * 0.33 + (69 / 1e6) * 16.50;
  approx(sReg.perCaller.judge.estimatedCostUsd, expectedReg, 1e-9)
    ? pass(`full-rate input still billed (${sReg.perCaller.judge.estimatedCostUsd.toFixed(8)})`)
    : fail(`got ${sReg.perCaller.judge.estimatedCostUsd} expected ${expectedReg}`);
  sReg.perCaller.judge.estimatedCostUsd > (1805 / 1e6) * 0.33 + (69 / 1e6) * 16.50
    ? pass("cost strictly exceeds cache-read + output — input was NOT clamped to zero")
    : fail("input clamped to zero — the pre-2026-08-26 bug is back");
  sReg.perCaller.judge.cachedTokenShare <= 1
    ? pass(`cachedTokenShare = ${sReg.perCaller.judge.cachedTokenShare.toFixed(3)} (a share, not a ratio > 1)`)
    : fail(`share ${sReg.perCaller.judge.cachedTokenShare} exceeds 1 — wrong denominator`);
  approx(sReg.perCaller.judge.avgInputTokens, 218 + 1805)
    ? pass("avgInputTokens = 2023, the whole prompt")
    : fail(`got ${sReg.perCaller.judge.avgInputTokens}`);

  section("Cache write — first call in window");
  resetBedrockMetrics();
  recordBedrockCall("judge", {
    inputTokens: 2240, // full-rate remainder of a 4,000-token prompt
    outputTokens: 50,
    cacheWriteInputTokens: 1760,
    durationMs: 1800,
  });
  const s3 = getBedrockMetrics();
  s3.perCaller.judge.cacheWrites === 1 ? pass("cache write counted") : fail("expected write");
  // 1760 × $4.125/M for the write, 2240 at normal input rate
  const expected3 =
    (2240 / 1e6) * 3.30 +
    (1760 / 1e6) * 4.125 +
    (50 / 1e6) * 16.50;
  approx(s3.perCaller.judge.estimatedCostUsd, expected3, 1e-6)
    ? pass(`cache-write cost ${s3.perCaller.judge.estimatedCostUsd.toFixed(6)} matches`)
    : fail(`got ${s3.perCaller.judge.estimatedCostUsd} expected ${expected3}`);

  section("Multiple callers — totals roll up");
  resetBedrockMetrics();
  recordBedrockCall("judge", { inputTokens: 500, outputTokens: 50, cacheReadInputTokens: 3500 });
  recordBedrockCall("judge", { inputTokens: 700, outputTokens: 55, cacheReadInputTokens: 3500 });
  recordBedrockCall("classifier", { inputTokens: 1900, outputTokens: 80, cacheWriteInputTokens: 1200 });
  const s4 = getBedrockMetrics();
  s4.totals.calls === 3 ? pass("totals.calls = 3") : fail(`got ${s4.totals.calls}`);
  s4.perCaller.judge.calls === 2 ? pass("judge calls = 2") : fail("judge count");
  s4.perCaller.classifier.calls === 1 ? pass("classifier calls = 1") : fail("classifier count");
  // totalInputTokens sums only the FULL-RATE portion; the cached 3500+3500 and
  // the written 1200 are tracked in their own counters, not folded in here.
  s4.totals.totalInputTokens === (500 + 700 + 1900)
    ? pass("totals.totalInputTokens sums the full-rate portion only")
    : fail(`got ${s4.totals.totalInputTokens}`);
  s4.totals.totalCacheReadTokens === 3500 + 3500
    ? pass("totals.totalCacheReadTokens tracked separately")
    : fail(`got ${s4.totals.totalCacheReadTokens}`);
  approx(s4.perCaller.judge.cacheHitRate, 1)
    ? pass("judge hitRate = 1")
    : fail("judge hitRate");
  approx(s4.perCaller.classifier.cacheHitRate, 0)
    ? pass("classifier hitRate = 0 (write, not read)")
    : fail("classifier hitRate");

  section("Unknown caller folds into 'unknown'");
  resetBedrockMetrics();
  recordBedrockCall("", { inputTokens: 100 });
  recordBedrockCall("unknown", { inputTokens: 200 });
  const s5 = getBedrockMetrics();
  s5.perCaller.unknown?.calls === 2
    ? pass("empty caller folded into 'unknown'")
    : fail(`unknown calls = ${s5.perCaller.unknown?.calls}`);

  section("Snapshot includes uptime + timestamp");
  const s6 = getBedrockMetrics();
  typeof s6.snapshotAt === "string" && s6.snapshotAt.length > 0
    ? pass(`snapshotAt = ${s6.snapshotAt}`)
    : fail("snapshotAt missing");
  typeof s6.processUptimeSec === "number" && s6.processUptimeSec >= 0
    ? pass(`processUptimeSec = ${s6.processUptimeSec}`)
    : fail("uptime missing");

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
