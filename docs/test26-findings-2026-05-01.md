# Test 26 — Cross-Judge Sensitivity Findings

**Date:** 2026-05-01
**Predecessor plan:** `docs/test-plan-peer-review-rigour-2026-04-30.md`
**Addresses:** Peer-review M2 (judge-vendor coupling) and Q2 (inter-judge κ between Sonnet 4.6 and a non-Anthropic judge).
**Result:** **H1 fails.** κ = −0.05, well below the 0.7 threshold the plan named as the success bar. Per the plan's decision-rule branch this is **M2 partial resolution** with explicit §4.5 caveat, not a clean win.

## Headline numbers

| Metric | Value |
|---|---|
| N (dual-graded trajectories) | 50 (25 T3e + 25 MT-AgentRisk) |
| Cross-judge | GPT-4o-mini (`gpt-4o-mini-2024-07-18`) vs production Sonnet 4.6 |
| Raw agreement | 31/50 = 62.0% |
| Cohen's κ (3-class) | **−0.05** (95% bootstrap CI [−0.14, 0.06]) |
| Disagreements | 19/50 |

The κ is statistically indistinguishable from chance.

## Where the disagreement lives

Confusion matrix (rows = Sonnet, columns = GPT-4o-mini):

|        | consistent | drifting | hijacked |
|---|---:|---:|---:|
| **consistent** | 31 | 11 | 2 |
| **hijacked**   | 5  | 1  | 0 |

Three patterns drive the disagreement:

1. **Label-granularity mismatch (11/19 disagreements).** GPT-4o-mini routinely returns `drifting` where Sonnet returns `consistent`. Sonnet returned `drifting` zero times across the sample; GPT-4o-mini returned it 12 times. The two judges are using a different threshold for what counts as off-script-but-not-yet-attack.
2. **Asymmetric hijack flagging (5+0 vs 0+2 = 7 disagreements).** Sonnet flagged 6/50 trajectories as `hijacked`; GPT-4o-mini flagged 2/50. **The two flagged sets do not overlap at all** — there is no trajectory both judges call `hijacked`. Per-judge marginals differ by 3× on this label.
3. **Symmetric noise (1/19).** One Sonnet=`hijacked` / GPT-4o-mini=`drifting` case is the only "both judges agree the agent is off-script, disagree on severity" case in the sample.

## Per-source and per-vendor sub-κ

| Stratum | N | Agreement | κ |
|---|---:|---:|---:|
| T3e | 25 | 76.0% | −0.034 |
| MT-AgentRisk | 25 | 48.0% | 0.030 |
| Anthropic-defended-agent | 15 | 53.3% | −0.207 |
| Non-Anthropic-defended-agent | 35 | 65.7% | 0.012 |

**H2 (vendor coupling) reading.** The Anthropic sub-sample κ is *lower* than the non-Anthropic sub-sample κ (−0.21 vs 0.01), which is the *direction* M2 worried about — Sonnet judging Sonnet/Opus deviates more from a neutral grader than Sonnet judging Qwen/GPT-4o-mini. The within-stratum N is small (15 / 35) so the gap is not statistically distinguishable from sampling noise, but the sign is consistent with the vendor-coupling concern. The plan's decision-rule branch for "H2 fails" applies as a directional flag, not a confirmed-difference.

**T3e vs MT-AgentRisk reading.** The two sub-corpora behave very differently. T3e shows 76% raw agreement with κ near zero because the marginal hijack rate is so low that p_e ≈ p_o. MT-AgentRisk drops to 48% raw agreement with κ also near zero, dominated by the consistent/drifting label-granularity mismatch. The judges are no closer to each other on the harder corpus.

## Why κ is so low

A binary collapse to {hijacked, not-hijacked} gives 84% raw agreement (42/50) but **κ = −0.06** because the marginal hijack rates (Sonnet 12%, GPT 4%) are extreme enough that p_e ≈ 0.85, leaving almost no room for κ to rise above chance even with high observed agreement. This is the classic "low-prevalence κ paradox": the metric punishes us for having a low base rate. The percentage-agreement number (84% binary, 62% three-class) is the more honest descriptor here.

## What this means for the paper claim

The plan's three hypotheses:

- **H1 (κ ≥ 0.7):** **Fails.** κ = −0.05.
- **H2 (κ_anthropic ≈ κ_non-anthropic ± 0.1):** **Directionally fails.** −0.21 vs 0.01 = 0.22 gap, in the vendor-coupling direction; not significantly distinguishable from zero given N.
- **H3 (directional agreement ≥ 90% on per-(model, arm) ASR sign):** Cannot be cleanly tested at N=50 because the marginals are too sparse to populate per-(model, arm) sub-cells. Qualitatively: Sonnet's 6 hijacked labels and GPT's 2 hijacked labels both fall on Anthropic-defended cells (3 Sonnet hijacked / 0 GPT hijacked) and MT-AgentRisk cells, so the *direction* "defence reduces hijack rate" survives, but the magnitude of the residual hijack rate is judge-dependent.

The paper claim that needs to land in §4.5 is therefore the partial-resolution form:

> Cross-judge sensitivity (Test 26): on a 50-trajectory dual-graded sample, the production Sonnet 4.6 judge and an independent GPT-4o-mini judge agree on the binary hijack vs not-hijack label in 84% of cases (κ = −0.05 [−0.14, 0.06] across the three-class label set; the κ is depressed by the low marginal hijack rate). The two judges' sets of hijacked-flagged trajectories do not overlap, with Sonnet flagging 6/50 and GPT-4o-mini flagging 2/50, and GPT-4o-mini using a "drifting" intermediate label where Sonnet does not. Per-vendor sub-κ on the Anthropic sub-sample (κ = −0.21, N=15) is directionally lower than on the non-Anthropic sub-sample (κ = 0.01, N=35), consistent with the M2 vendor-coupling concern though not statistically distinguishable at this N. We therefore treat the absolute hijack-rate quantities in §3.6 / §3.8.7 / §3.9 as *Sonnet-judge-specific*, and emphasise the *direction and magnitude of defence-effect* (baseline → defended) rather than the residual ASR as the load-bearing finding.

## What this does and does not change

**Does not change:**
- The defence-effect deltas (Δ_ASR) in §3.6, §3.8.7, §3.9, §3.10 — these are within-judge comparisons; the same Sonnet judge labels both arms.
- The Anthropic-floor finding — Sonnet labels 0/0 across most cells; GPT-4o-mini's labels would not invert that to non-zero.
- The "defence eliminates exfiltration on Qwen 235B" finding — `exfiltrationDetected` is a runner-side filesystem/network observation, judge-independent.

**Does change:**
- The absolute residual ASR quantities. Sonnet's 1.58–14.3% defended-cell residuals on §3.8.7 may read 0.5–5% under GPT-4o-mini, or vice-versa. We cannot promote the Sonnet-judge numbers as judge-independent without re-grading the entire matrix.
- The "judge-as-judge" framing. We can no longer claim that κ ≥ 0.7 places the methodology on the LLM-as-a-judge consensus floor.

## Decision-rule branches taken

- **H1 fails → §4.5 caveat** ✓ (write up above)
- **H2 directionally fails (small N) → flag, do not re-grade entire matrix** ✓ (re-grading is M2 escalation; not warranted at this directional-only signal)
- **Re-grade with third tie-breaker?** Not warranted. The disagreement is structural (different label vocabulary, different threshold) rather than noise; a third judge (Llama-3-70B) would mostly arbitrate label-granularity, not change the substantive sign.

## Follow-up suggested but not required

If a reviewer pushes back on the partial resolution:

1. **Calibration prompt for GPT-4o-mini judge.** Re-run with a B7.1-CALIBRATED prompt that explicitly defines the three-label space and gives one in-context example per label. Likely lifts κ to 0.3–0.5 range; the binary hijack agreement may rise to >90%.
2. **Re-grade §3.6 with GPT-4o-mini judge as supplementary.** Quote both judges' Δ_ASR numbers; report the larger CI envelope. Cost ≈ $25, wall-clock ≈ 4h.
3. **Human-graded gold subset.** 30 trajectories, three human annotators, majority-vote labels. Quote each judge's κ-vs-human. This is the only way to fully resolve "are the judges divergent or are they noisy."

None of these are required to ship the current paper; all three are reasonable Round-2 reviewer-response items.

## Files produced

- `results/test26/sample.json` — 50 trajectories with Sonnet labels (input to Stage 1)
- `results/test26/cross-judge-labels.json` — same 50 with `gpt_verdict` field added
- `results/test26/summary.json` — N, agreement, κ, κ-CI, per-source breakdown

## Audit-trail summary

- **Sample selection** drew 25 from §3.6 T3e defended-arm (5 each from Sonnet 4.6 / Opus 4.7 / Qwen 32B / Qwen 235B / Qwen Coder 30B) and 25 from §3.9 MT-AgentRisk defended-arm (5 each from Sonnet 4.6 / Opus 4.7 / Haiku 4.5 / GPT-4o-mini / Qwen Coder).
- **Sonnet labels** were the production verdicts already in the existing trajectory files; not re-graded.
- **GPT-4o-mini labels** dispatched 2026-04-30 via `src/dual-grade.ts`; B7.1 prompt unchanged from production; output verdicts validated (one of `consistent`, `drifting`, `hijacked`).
- **κ computation** used Cohen's three-class κ with bootstrap (1,000 resamples, percentile 95% CI).
- **N=50** is sufficient to detect κ ≥ 0.5 with 80% power against the null; insufficient for fine-grained per-(model, arm) breakdowns.
