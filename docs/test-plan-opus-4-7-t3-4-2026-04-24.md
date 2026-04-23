# Test Plan — Opus 4.7 on T3.4 (8-turn extended-drift scenario)

**Date:** 2026-04-24
**Context:** Peer review of `p15.tex` (`Adrian/p15/PEER_REVIEW.md` M4; also `Adrian/p15/toconsider.md` §1.3 and §6.9 line 835) noted that Opus 4.7 cross-model results appear in prose only, not in the `tab:cross-model-scenario` table. The Opus 4.7 re-run was a partial T3.2/T3.3 follow-up; T3.4 (8-turn minimal-drift escalation) was never run.
**Priority:** Medium. Not blocking for submission. Fills out a row in `tab:cross-model-scenario` and lets the regression-from-Opus-4.6 finding be stated with a complete agent-model matrix rather than a partial one.

## What we have now

The cross-model evaluation (§6.9) tested three agent models across T3.2 / T3.3 / T3.4:

| Agent model | T3.2 | T3.3 | T3.4 |
|---|---|---|---|
| Haiku 4.5 | ✓ | ✓ | ✓ |
| Sonnet 4.6 | ✓ | ✓ | ✓ |
| **Opus 4.6** | ✓ | ✓ | ✓ |
| **Opus 4.7** | ✓ *(prose only)* | ✓ *(prose only)* | **missing** |

Opus 4.7 defended-mean GES from the partial re-run:
- T3.2: **82.5** (vs. Opus 4.6 = 86.7, −4.2 pp regression)
- T3.3: **71.7** (vs. Opus 4.6 = 93.3, **−21.6 pp regression**)
- T3.4: not measured

Baseline (undefended) Opus 4.7 was not re-measured on T3.2/T3.3 either — the prose only reports defended numbers. A clean table requires baseline as well.

## What this plan adds

Fill the Opus 4.7 row for T3.2, T3.3, **and T3.4**, under both baseline and intent-tracker (full pipeline) configurations. Produces a directly comparable cross-model matrix with no gaps.

**Gaps after this plan:**

1. Opus 4.7 × T3.1 (2-turn direct attack) — deliberately omitted. T3.1 already produces 100% hijack rate across all tested models; adding Opus 4.7 here does not inform the regression story and wastes compute.
2. Cross-model on the adversarial single-turn suite — separate question, not in scope.

## Evaluation matrix

| Axis | Values | Notes |
|---|---|---|
| Agent model | Claude Opus 4.7 | `eu.anthropic.claude-opus-4-7-20251017-v1:0` on Bedrock |
| Scenario | T3.2, T3.3, T3.4 | T3.2 = 4-turn, T3.3 = 6-turn, T3.4 = 8-turn minimal-drift |
| Defence | baseline (none), intent-tracker (full) | Judge = Haiku 4.5 + prompt v2 in the tracker |
| Repetitions | N=20 per cell | Matches §6.9's existing Haiku/Sonnet/Opus-4.6 cell count |
| Reasoning effort | `medium` | Matches §6.9 convention for Opus-tier defended agents |

**Total runs:** 3 scenarios × 2 defences × 20 reps = **120 multi-turn runs**.

**Scenario T3.4 specifics:** 8-turn escalation with per-turn similarity drops smaller than T3.2/T3.3 (0.29–0.49 at turn 1 vs 0.25–0.37). Expected to be the hardest scenario for the defence — on Opus 4.6 the defence still improved GES substantially (from 66.7 baseline to 88.3 defended = +21.6 pp), so the question is whether Opus 4.7 shows a similar regression on T3.4 as it did on T3.3.

## Hypotheses

**H1 — Opus 4.7 shows a T3.4 regression consistent with its T3.3 regression.** If the Opus 4.6 → 4.7 degradation on T3.3 (−21.6 pp) reflects a shift in the model's response to gradual escalation, T3.4 (even more gradual) should show a similar or larger gap. Predicted: Opus 4.7 defended GES on T3.4 around 65–75 (vs. Opus 4.6 defended = 88.3).

**H2 — T3.4 is a floor effect across models and the Opus-4.6-to-4.7 gap narrows.** T3.4 is already the hardest scenario (Haiku 4.5 sees no improvement from defence: 83.3 → 83.3). If Opus 4.7 matches this floor, the regression is not T3.3-specific but reflects an overall ceiling the defence can't exceed on gradual attacks. Predicted: Opus 4.7 defended T3.4 in the 80–90 range, similar to Opus 4.6.

**H3 — Opus 4.7 baseline is also materially lower than Opus 4.6 baseline.** The prose only reports *defended* Opus 4.7 numbers. If baseline Opus 4.7 is also lower, the observed regression reflects the underlying model's shift in defensive posture rather than a defence-specific failure. Predicted: baseline Opus 4.7 T3.2/T3.3/T3.4 tracks within 5 pp of Opus 4.6 baseline.

## Success criteria

1. **Provenance fields populated** on every result JSON: `build.gitSha`, `agent.provider=bedrock`, `agent.model=eu.anthropic.claude-opus-4-7-20251017-v1:0`, `agent.effort=medium`, `judge.model=eu.anthropic.claude-haiku-4-5-20251001-v1:0`, `judge.prompt=v2`, `run.timestamp`, `run.bedrockRegion=eu-central-1`.
2. **Opus 4.7 baseline reproduces previous partial-re-run numbers within ±5 pp** where those exist (T3.2 defended 82.5, T3.3 defended 71.7). Large drift means Bedrock has silently updated the weights; document and proceed.
3. **Table `tab:cross-model-scenario` can be filled completely** from the resulting data without gaps.

## Decision rules

**If H1 is supported (Opus 4.7 T3.4 defended GES < 80):**
- Frame as: "Opus 4.6 → 4.7 is a multi-scenario regression, not T3.3-specific".
- Strengthens the §6.9 finding that the defence's marginal value depends on the specific agent model being defended.
- Update `toconsider.md` §1.3 (Opus 4.6 as judge) — if defended-agent regression is real, it might be worth testing Opus 4.7 as judge too, separately.

**If H2 is supported (Opus 4.7 T3.4 defended GES 80–90):**
- Frame as: "regression is T3.3-specific, reflects Opus 4.7's handling of sophisticated (6-turn) but not extended-gradual (8-turn) attacks".
- Weakens the "regression" narrative but preserves the tabular completeness argument.

**If H3 is supported (baseline Opus 4.7 is materially different from Opus 4.6):**
- Frame as: "observed defended-GES shift partly reflects underlying agent behaviour, not purely defence degradation".
- Requires a caveat in §6.9 prose; the current narrative overstates the defence-attribution slightly.

## Execution

### Infrastructure

- Fargate task with `OPUS_4_7` model access already provisioned (used for earlier partial re-run).
- Judge side: Haiku 4.5 + prompt v2, already shipped (commit `831b5f8`-onwards).
- No new AWS permissions or model subscriptions required.

### Command

```bash
# From repo root. Assumes AWS_REGION + Bedrock creds exported.
AWS_REGION=eu-central-1 npx tsx src/runner.ts \
  --agent-model eu.anthropic.claude-opus-4-7-20251017-v1:0 \
  --agent-effort medium \
  --scenario T3.2,T3.3,T3.4 \
  --defence baseline,intent-tracker \
  --repetitions 20 \
  --judge-model eu.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --judge-prompt v2 \
  --out results/opus-4-7-t3-all/
```

### Wall-clock and cost

- **Runtime:** multi-turn runs average ~90 s per run (8-turn T3.4 takes longer than 4-turn T3.2). 120 runs × ~90 s = ~3 h wall-clock.
- **Cost:** Opus 4.7 is the most expensive model (~$15 / M input, ~$75 / M output). 120 runs × ~2 k tokens each × mostly input → estimate **$10–20** for agent + judge combined.

Run overnight on Fargate.

### Paper integration

**`p15.tex` §6.9 tables to update:**

1. `tab:cross-model-baseline` — add an Opus 4.7 row with the three scenario mean GES values (derived from aggregating T3.2/T3.3/T3.4 per the existing table convention: weighted mean, N=60).
2. `tab:cross-model-defended` — add an Opus 4.7 row with defended mean GES and $\Delta$GES from Opus 4.7 baseline.
3. `tab:cross-model-scenario` — add an Opus 4.7 row × three scenarios.

**§6.9 prose to update:**

- The line 835 "Opus 4.7 re-run" paragraph becomes a sentence referencing the tables rather than carrying the numbers inline.
- The conclusion "the regression is T3.3-specific" or "the regression is multi-scenario" is determined by the H1/H2 outcome.

**toconsider.md updates:**

- Move §1.3 (Opus 4.6 as judge) to resolved if the defended-agent regression story doesn't motivate adding it.
- Close §2.3 (prompt v2 FPR) — separate, unaffected.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Opus 4.7 baseline has drifted from the earlier re-run (Bedrock weight update) | Low | Medium | Re-run baseline first; if drift > ±5 pp document and note in §7.3 Limitations |
| Opus 4.7 T3.4 times out or rate-limits on Bedrock | Medium | Low | Configure `maxAttempts=5` retry in the runner; if it persists, halve the parallelism |
| Results contradict H1/H2/H3 cleanly (neither regression nor floor) | Low | Low | Extends the finding space; write up honestly |
| Cost overrun (multi-turn Opus 4.7 is more expensive than estimated) | Medium | Low | Budget cap $50; halt if exceeded |

## Non-goals

- Cross-model adversarial single-turn (§6.5) evaluation with Opus 4.7 as defended agent. That's a separate question and is partially covered by §6.5's existing Opus 4.7 row *as judge*.
- Opus 4.7 as the judge (rather than defended agent). See `toconsider.md` §1.3 for that separately-scoped question.
- Running T3.1 on Opus 4.7. T3.1 is 100% hijack-rate across all tested agents; the extra data point doesn't inform the story.

## Dependencies on other open items

- **Complements:** `test-requirements-agentdojo-gpt4o-2026-04-20.md` (external benchmark validation) — orthogonal, can run in parallel.
- **Does not depend on:** the `toconsider.md` §2.4 edge-1 label update in the data files. Multi-turn scenarios use different test fixtures from the single-turn adversarial suite.
