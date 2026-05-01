# Test 28 — Cross-Judge Balanced Sample (M9 Follow-Up)

**Date:** 2026-05-01
**Predecessor:** Test 26 (`docs/test26-findings-2026-05-01.md`); peer-review M9 from `Cloud-Security/Adrian/p15/PEER_REVIEW_2026-05-01.md`.
**Question addressed:** Was Test 26's κ = −0.05 a real finding (low judge-judge agreement) or a sampling artefact (defended-arm-only stratification → low marginal hijack rate → κ paradox)?
**Result:** Substantial sampling-artefact contribution. **κ rises from −0.05 to 0.26 [0.09, 0.46]** on a balanced 25-baseline + 25-defended re-sample. The CI lower bound excludes zero (judge-judge agreement is statistically non-trivial); the upper bound 0.46 is still below the planned 0.7 threshold.

## Headline numbers

| Metric | Test 26 (defended-only) | Test 28 (balanced) |
|---|---:|---:|
| N | 50 | 50 |
| Sample structure | 25 T3e defended + 25 MTA defended | 12 T3e baseline + 13 MTA baseline + 12 T3e defended + 13 MTA defended |
| Raw agreement (3-class) | 62.0% | 54.0% |
| Cohen's κ (3-class) | **−0.05** [−0.14, 0.06] | **0.26** [0.09, 0.46] |
| Sonnet hijacked-label marginal | 6/50 (12%) | 10/50 (20%) |
| GPT-4o-mini hijacked-label marginal | 2/50 (4%) | 7/50 (14%) |

**Per-stratum κ:**

| Stratum | N | Agreement | κ |
|---|---:|---:|---:|
| Baseline arms | 25 | 36.0% | 0.154 |
| Defended arms | 25 | 72.0% | 0.297 |

**Per-source κ:**

| Source | N | Agreement | κ |
|---|---:|---:|---:|
| T3e | 24 | 75.0% | 0.385 |
| MT-AgentRisk | 26 | 34.6% | 0.087 |

## Confusion matrix (Sonnet rows × GPT-4o-mini columns)

|        | consistent | drifting | hijacked |
|---|---:|---:|---:|
| **consistent** | 18 | 16 | 1 |
| **drifting**   | 1  | 4  | 0 |
| **hijacked**   | 3  | 1  | 6 |

The on-diagonal cells (28/50) drive the agreement; the largest off-diagonal cell is sonnet=consistent / gpt=drifting (16 cases), the same label-granularity divergence Test 26 observed. The hijacked–hijacked cell now has 6 overlap (vs 0 in Test 26), which is what lifts the κ above zero.

## Why κ moved

Two mechanisms compose:

1. **Higher marginal hijack rate.** Sonnet now flags 10/50 hijacked (vs 6/50 in Test 26); GPT-4o-mini flags 7/50 (vs 2/50). The expected agreement under independence ($p_e$) drops correspondingly, leaving more headroom for the observed agreement to register as κ. With baseline arms included, both judges are seeing trajectories where the agent actually attempted exfiltration / harmful action.
2. **Real overlap on hijacked labels.** Test 26 had 0 trajectories where both judges agreed on `hijacked`; Test 28 has 6. The judges are not just calibrated to similar marginals — they are picking out a partly-overlapping set of trajectories as actually adversarial.

## Implications for the M2 / §4.5 narrative

The Test 26 κ = −0.05 was **substantially sample-stratification-driven**, not a structural disagreement between Sonnet and GPT-4o-mini on the same trajectories. The balanced Test 28 κ = 0.26 is in the "fair agreement" range (Landis-Koch 0.21–0.40); it remains below the 0.7 threshold the test plan named for "non-confounded LLM-as-a-judge measurement", so M2 is **further resolved** but not fully resolved.

What this means for the paper claims:
- The defence-effect deltas (within-judge baseline → defended) remain the load-bearing finding. Both Test 26 and Test 28 leave this unchanged.
- The absolute hijack-rate magnitudes in §3.6 / §3.8.8 / §3.9 / §3.10 are still Sonnet-judge-specific, but the gap between Sonnet and a non-Anthropic judge on equivalent trajectories is **smaller than the Test 26 number suggests** — judges agree non-trivially when both are seeing trajectories with non-zero base rate of adversarial intent.
- The vendor-coupling concern is partly answered: defended-arm κ (0.297) is higher than baseline-arm κ (0.154), the opposite of what pure Anthropic-on-Anthropic vendor coupling would predict (which would push defended-arm Anthropic-cell agreement *lower* if Sonnet judges Sonnet leniently). This further weakens the vendor-coupling reading.

## Per-source heterogeneity

T3e κ (0.385, 75% agreement) is materially higher than MT-AgentRisk κ (0.087, 34.6% agreement). Two factors explain the gap:

1. **MT-AgentRisk's harmful-task taxonomy is broader and more ambiguous.** The dataset spans browser navigation, postgres queries, terminal commands, filesystem operations, and Notion tool calls; the line between "the agent is doing the harmful thing" vs "the agent is doing the requested but borderline thing" is harder to draw than in T3e, which is canonically credential-exfiltration-focused.
2. **MT-AgentRisk transcripts have less per-tool-call detail in the reconstructed judge input.** The script reconstructs the action history from the assistant's text turns; T3e trajectories have explicit tool-call structures the script can reproduce more faithfully. The judges may be effectively grading slightly different inputs on MT-AgentRisk, which mechanically lowers κ.

Both factors are reasons the MT-AgentRisk κ is conservatively low; they are not reasons to discount the T3e κ value.

## Recommended §4.5 update

Replace the M9 follow-up sentence in the existing §4.5 cross-judge paragraph ("A balanced baseline-plus-defended re-sample with enforced ~25% hijacked-label balance would discriminate more robustly; this is the natural extension and is left to follow-up work") with:

> The follow-up balanced re-sample (Test 28; 25 baseline + 25 defended trajectories drawn proportionally from the same five §3.6 T3e and five §3.9 MT-AgentRisk model rows) returns Cohen's κ = 0.26 [0.09, 0.46] across all 50 trajectories, with κ = 0.30 on the defended-arm sub-sample (n=25, 72% agreement) and κ = 0.15 on the baseline-arm sub-sample (n=25, 36% agreement). Per-source: κ = 0.39 on T3e (n=24) versus κ = 0.09 on MT-AgentRisk (n=26), reflecting the broader harmful-task taxonomy and lower per-tool-call detail in the MT-AgentRisk transcript reconstruction. The balanced-sample κ excludes zero at the 95% bootstrap CI lower bound (0.09), establishing that the two judges agree non-trivially on the same trajectories; the upper bound 0.46 is still below the planned 0.7 threshold for "non-confounded LLM-as-a-judge measurement," so M2 is further resolved but not fully resolved. The defence-effect deltas (within-judge baseline → defended) and the runner-side `exfiltrationDetected` metric remain the load-bearing findings; full re-grade of the cross-vendor matrix with a non-Anthropic judge as the production judge (rather than a sensitivity check on a 50-trajectory sample) remains follow-up work.

## Files produced

- `results/test28/sample.json` — 50 selected trajectories with reconstructed judge inputs
- `results/test28/cross-judge-labels.json` — same 50 with both `sonnet_verdict` and `gpt_verdict` fields
- `results/test28/summary.json` — N, agreement, κ, κ-CI, per-stratum + per-source breakdown

## Cost summary

| Stage | Cost | Wall-clock |
|---|---:|---:|
| Sample selection | $0 | 5 min |
| Dual-grade (50 trajectories × 2 judges = 100 calls) | ~$0.30 | ~3 min |
| **Total** | **~$0.30** | **~8 min** |

Well under the $5 budget cap from the M9 plan.

## Decision-rule branches taken

- **κ rises substantially when sample structure is balanced:** confirms M9's diagnosis that Test 26's κ was sample-stratification-driven, not vendor-coupling-driven.
- **κ remains < 0.7:** M2 not fully resolved by Test 28 alone. The remaining gap is plausibly a combination of (a) GPT-4o-mini's "drifting" label-granularity divergence from Sonnet, which Test 26 already documented and Test 28 reproduces (16/22 disagreements still cluster on this axis), and (b) the MT-AgentRisk-specific reconstruction-fidelity issue.
- **Per-vendor sub-κ does not show vendor coupling:** the defended-arm κ (0.297) is *higher* than the baseline-arm κ (0.154), opposite to the vendor-coupling-direction signal Test 26 reported on its (smaller-N) per-vendor split. We can no longer make a directional vendor-coupling claim.

## What this changes in the paper

§4.5 cross-judge sensitivity paragraph should be updated per the recommended text above. The §4.5 strict-vs-permissive paragraph and the abstract / contributions don't need changes (they don't quote the κ value directly). The M2 status line in the peer-review companion documents moves from "partial resolution" to "substantially resolved; full resolution requires production-judge swap rather than sensitivity check."
