/**
 * Bedrock cost-visibility metrics.
 *
 * The judge and the intent classifier are our two Sonnet 4.6 callers.
 * Each call costs $3.30/M input tokens uncached, $0.33/M when read
 * from the 5-minute prompt cache. Without per-call cache-hit info we
 * can't tell whether the cachePoint marker in `bedrock-client.ts` is
 * actually saving money or whether something is invalidating the cache
 * key every call.
 *
 * This module is a tiny in-process accumulator: every `bedrockChat`
 * call records its tokens here keyed by caller name. The hook server
 * exposes the snapshot at `GET /api/bedrock-metrics`.
 *
 * In-process only — restarts reset the counters. That's fine for
 * cost-visibility: we want to see a recent few hours and compare against
 * the AWS Bedrock CloudWatch metrics (which lag ~3h). Container
 * restarts are infrequent enough that we'll catch enough samples in
 * any working window.
 *
 * Not exported to Dynamo. If we ever need durable accounting we can
 * stamp these into session META instead.
 */

export interface BedrockCallStats {
  /** Total invocations recorded for this caller. */
  calls: number;
  /** Number of calls where cacheReadInputTokens > 0 (cache hit). */
  cacheHits: number;
  /** Number of calls where cacheWriteInputTokens > 0 (cold write). */
  cacheWrites: number;
  /** Sum of `inputTokens` across all calls. EXCLUDES the cache-read and
   *  cache-write portions — Bedrock reports the three as disjoint, and
   *  `totalTokens == inputTokens + cacheRead + cacheWrite + outputTokens`.
   *  Verified 2026-08-26 against eu.anthropic.claude-sonnet-4-6: a 2,409-token
   *  cached prefix reported inputTokens=13, cacheWrite=2409, totalTokens=2426.
   *  These are the tokens billed at FULL input rate. */
  totalInputTokens: number;
  /** Sum of cached input portion (billed at ~10% of normal). */
  totalCacheReadTokens: number;
  /** Sum of cache-write portion (billed at ~125% of normal). */
  totalCacheWriteTokens: number;
  /** Sum of output tokens. */
  totalOutputTokens: number;
  /** Total time spent in Bedrock for this caller (ms). */
  totalDurationMs: number;
  /** First and last call timestamps (ISO). */
  firstCallAt: string | null;
  lastCallAt: string | null;
}

function emptyStats(): BedrockCallStats {
  return {
    calls: 0,
    cacheHits: 0,
    cacheWrites: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalOutputTokens: 0,
    totalDurationMs: 0,
    firstCallAt: null,
    lastCallAt: null,
  };
}

const stats = new Map<string, BedrockCallStats>();

export interface BedrockCallRecord {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  durationMs?: number;
}

/** Record one bedrockChat invocation. Caller names should be short and
 *  stable — "judge", "classifier", "promptarmor", "preflight". Unknown
 *  callers fold into "unknown" so a forgotten call site is still
 *  visible in the metrics. */
export function recordBedrockCall(caller: string, r: BedrockCallRecord): void {
  const key = caller || "unknown";
  const s = stats.get(key) ?? emptyStats();
  const now = new Date().toISOString();
  s.calls += 1;
  const cr = r.cacheReadInputTokens ?? 0;
  const cw = r.cacheWriteInputTokens ?? 0;
  if (cr > 0) s.cacheHits += 1;
  if (cw > 0) s.cacheWrites += 1;
  s.totalInputTokens += r.inputTokens ?? 0;
  s.totalCacheReadTokens += cr;
  s.totalCacheWriteTokens += cw;
  s.totalOutputTokens += r.outputTokens ?? 0;
  s.totalDurationMs += r.durationMs ?? 0;
  if (!s.firstCallAt) s.firstCallAt = now;
  s.lastCallAt = now;
  stats.set(key, s);
}

export interface BedrockMetricsSnapshot {
  /** When this snapshot was generated. */
  snapshotAt: string;
  /** Process uptime in seconds — useful for back-of-envelope rate calcs. */
  processUptimeSec: number;
  /** Per-caller stats. */
  perCaller: Record<string, BedrockCallStats & {
    /** Derived: cacheHits / calls. */
    cacheHitRate: number;
    /** Derived: cacheRead / (input + cacheRead + cacheWrite). The fraction of
     *  the PROMPT billed at the discounted rate. Denominator is the full
     *  prompt, not `totalInputTokens` — those counters are disjoint, so the
     *  old ratio could exceed 1 (observed 1805/218 = 8.3). */
    cachedTokenShare: number;
    /** Derived: average PROMPT tokens per call — input + cacheRead +
     *  cacheWrite. Not `totalInputTokens / calls`, which counts only the
     *  full-rate portion and understates prompt size whenever caching hits. */
    avgInputTokens: number;
    /** Derived: estimated USD cost on Claude Sonnet 4.6 EU rates
     *  ($3.30/M input, $0.33/M cache-read, $4.125/M cache-write,
     *  $16.50/M output). Updates as new pricing lands by editing
     *  this constant block. */
    estimatedCostUsd: number;
  }>;
  /** Total across all callers — handy for a single Slack/console line. */
  totals: BedrockCallStats & {
    cacheHitRate: number;
    cachedTokenShare: number;
    avgInputTokens: number;
    estimatedCostUsd: number;
  };
}

// Sonnet 4.6 EU (eu.anthropic.claude-sonnet-4-6) — published rates in
// USD per 1M tokens. Cache-read is 10% of normal input; cache-write
// is 125% of normal input. Output is unaffected by cache.
const PRICE_INPUT_PER_M = 3.30;
const PRICE_CACHE_READ_PER_M = 0.33;
const PRICE_CACHE_WRITE_PER_M = 4.125;
const PRICE_OUTPUT_PER_M = 16.50;

function deriveExtras(s: BedrockCallStats) {
  const cacheHitRate = s.calls > 0 ? s.cacheHits / s.calls : 0;
  // The three input counters are DISJOINT: Bedrock reports
  //   totalTokens == inputTokens + cacheRead + cacheWrite + outputTokens
  // Verified 2026-08-26 on eu.anthropic.claude-sonnet-4-6 — a 2,409-token
  // cached prefix returned inputTokens=13, cacheWrite=2409, totalTokens=2426.
  //
  // This code previously subtracted cacheRead+cacheWrite out of inputTokens,
  // believing input carried the whole prompt. That clamped uncached input to
  // ZERO whenever the cached prefix exceeded the per-call user prompt — the
  // normal case for the judge, whose ~1.8K system prompt caches while the user
  // prompt is a few hundred tokens (observed: input=218, cacheRead=1805). The
  // meter therefore billed no full-rate input at all and read low by
  // min(input, cacheRead+cacheWrite) x $3.30/M. August 2026's overspend went
  // unnoticed precisely because nobody was watching a cost meter; a meter that
  // reads low is the wrong bug to have.
  const promptTokens =
    s.totalInputTokens + s.totalCacheReadTokens + s.totalCacheWriteTokens;
  const cachedTokenShare = promptTokens > 0 ? s.totalCacheReadTokens / promptTokens : 0;
  const avgInputTokens = s.calls > 0 ? promptTokens / s.calls : 0;
  const cacheReadCost = (s.totalCacheReadTokens / 1_000_000) * PRICE_CACHE_READ_PER_M;
  const cacheWriteCost = (s.totalCacheWriteTokens / 1_000_000) * PRICE_CACHE_WRITE_PER_M;
  const uncachedInputCost = (s.totalInputTokens / 1_000_000) * PRICE_INPUT_PER_M;
  const outputCost = (s.totalOutputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
  const estimatedCostUsd = cacheReadCost + cacheWriteCost + uncachedInputCost + outputCost;
  return { cacheHitRate, cachedTokenShare, avgInputTokens, estimatedCostUsd };
}

export function getBedrockMetrics(): BedrockMetricsSnapshot {
  const perCaller: BedrockMetricsSnapshot["perCaller"] = {};
  const totals = emptyStats();
  for (const [name, s] of stats) {
    perCaller[name] = { ...s, ...deriveExtras(s) };
    totals.calls += s.calls;
    totals.cacheHits += s.cacheHits;
    totals.cacheWrites += s.cacheWrites;
    totals.totalInputTokens += s.totalInputTokens;
    totals.totalCacheReadTokens += s.totalCacheReadTokens;
    totals.totalCacheWriteTokens += s.totalCacheWriteTokens;
    totals.totalOutputTokens += s.totalOutputTokens;
    totals.totalDurationMs += s.totalDurationMs;
    if (!totals.firstCallAt || (s.firstCallAt && s.firstCallAt < totals.firstCallAt)) {
      totals.firstCallAt = s.firstCallAt;
    }
    if (!totals.lastCallAt || (s.lastCallAt && s.lastCallAt > totals.lastCallAt)) {
      totals.lastCallAt = s.lastCallAt;
    }
  }
  return {
    snapshotAt: new Date().toISOString(),
    processUptimeSec: Math.round(process.uptime()),
    perCaller,
    totals: { ...totals, ...deriveExtras(totals) },
  };
}

/** Test/diagnostic helper. */
export function resetBedrockMetrics(): void {
  stats.clear();
}
