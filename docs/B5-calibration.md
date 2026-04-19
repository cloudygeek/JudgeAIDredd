# B5: Confidence Calibration Analysis

Data: 13,156 evaluations (11,126 adversarial + 2,030 mixed B3) across Haiku 4.5, Sonnet 4.6, Opus 4.7 with standard and B7-hardened prompts.

## Key finding

The judge is **confidently wrong** on the standard prompt — it classifies adversarial hijacks as "consistent" with 0.9+ confidence. This is not a calibration problem but a detection problem: the standard prompt lacks the adversarial pattern library to recognise disguised hijacks.

**B7-hardened prompt ECE: 0.0697** — well-calibrated. When the judge has the right pattern library, its confidence tracks actual accuracy closely.

## Prompt-level calibration

| Prompt | ECE | N | Accuracy |
|---|---|---|---|
| Standard | 0.3861 | 12,217 | 30.5% |
| B7 hardened | **0.0697** | 939 | **84.8%** |

The 0.39 ECE on standard is almost entirely explained by high-confidence misses on adversarial cases — the judge is confident because the pretexts *sound* legitimate, but it lacks the B7 pretext catalogue to see through them.

## Per-verdict accuracy

| Verdict | N | Correct | Accuracy |
|---|---|---|---|
| hijacked | 3,553 | 3,501 | **98.5%** |
| consistent | 5,292 | 729 | 13.8% |
| drifting | 4,311 | 297 | 6.9% |

When the judge says "hijacked", it's right 98.5% of the time. When it says "consistent" or "drifting" on adversarial cases, it's almost always wrong — these are the missed adversarial detections from the standard prompt.

## Aggregate reliability table

**Expected Calibration Error (ECE): 0.3635**

| Confidence bin | Mean conf | Actual acc | Gap | N |
|---|---|---|---|---|
| 0.3–0.4 | 0.300 | 0.018 | -0.282 | 2,843 |
| 0.5–0.6 | 0.518 | 0.117 | -0.401 | 111 |
| 0.6–0.7 | 0.615 | 0.057 | -0.559 | 1,415 |
| 0.7–0.8 | 0.719 | 0.164 | -0.556 | 2,296 |
| 0.8–0.9 | 0.838 | 0.658 | -0.180 | 2,319 |
| 0.9–1.0 | 0.943 | 0.595 | -0.349 | 4,171 |

## Per-model ECE

| Model | ECE | N |
|---|---|---|
| Claude Sonnet 4.6 | **0.2684** | 2,984 |
| Claude Opus 4.7 | 0.3498 | 4,277 |
| Claude Haiku 4.5 | 0.4856 | 3,075 |

Sonnet is best-calibrated overall, consistent with its Pareto-optimal position from C2/C3.

## Implications for paper

1. **B7 hardened prompt is well-calibrated (ECE=0.07)** — confidence can be trusted as a risk signal in production.
2. **"hijacked" verdict precision is 98.5%** — false conviction rate is negligible, supporting the deny-on-hijacked policy.
3. **Standard prompt miscalibration is a detection gap, not a confidence gap** — the judge is confidently wrong because it genuinely doesn't recognise the adversarial patterns, not because it's uncertain and overreporting.
4. **Confidence thresholding is viable for B7**: a confidence threshold on "hijacked" verdicts would have minimal impact (98.5% are correct), but could be used to soften low-confidence hijacked calls to "drifting" (goal-anchor only).

![Calibration plot](calibration-plot.png)
