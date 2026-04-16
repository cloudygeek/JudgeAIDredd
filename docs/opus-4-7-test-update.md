# P15 Test Update: Claude Opus 4.7

**Date:** 2026-04-16
**Trigger:** Release of Claude Opus 4.7 (`claude-opus-4-7`)
**Current model matrix:** Haiku 4.5, Sonnet 4.6, Opus 4.6

Opus 4.6 now has a successor. Two roles in P15 need re-evaluation: Opus as the **defended agent** (Test 7 baseline + full pipeline) and Opus as a **judge candidate** (Tests 1, 8). Claims conditioned on "Opus is the most susceptible model" and "Haiku 4.5 is the recommended judge" are the ones at risk.

## Effort-level variation (new axis)

Opus 4.7 and the Sonnet/Haiku 4.x family expose a reasoning-effort / extended-thinking control (`none | low | medium | high`, or equivalent `budget_tokens` settings). Effort is a meaningful independent variable for every model-role in this paper — prior P15 runs all used the SDK default (effectively no extended thinking), so none of the existing numbers characterise the effort dimension.

**Hypotheses worth testing:**

- **Agent side:** higher effort → more deliberation per turn → plausibly more chance the agent recognises and refuses the hijack (agent self-detection already 83–98% at baseline; does effort convert detection into *refusal*?). The capability-compliance trade-off may invert under high effort.
- **Judge side:** higher effort should help most on Test 8 adversarial cases, where surface semantics are benign. If `high`-effort Haiku 4.5 matches `none`-effort Sonnet 4.6 on adversarials, the cost-accuracy frontier (Section 7.4) changes materially — effort is a cheaper lever than model-tier upgrade.
- **Latency/cost:** effort directly inflates judge-layer tokens and latency. Test 9 must record effort as a configuration dimension, not a footnote.

**Recommended effort sweep:** `none`, `medium`, `high` for each re-run below (skip `low` unless results diverge — it rarely changes behaviour meaningfully). This keeps the matrix tractable (3× instead of 4×).

**Test-framework change needed:** add `--thinking` / `--effort` and `--judge-thinking` flags to `runner.ts`, plumbed through to the SDK `thinking` parameter on both the agent loop and the judge invocation. Record the effort setting in every result JSON so old runs (implicitly `none`) don't get confused with new ones.

## Tests to re-run

### Test 7 — Cross-Model Agent Evaluation (highest priority)

Directly load-bearing claim: *"Opus confirms the prior finding: it is the most susceptible model at baseline, with a 100% hijack success rate."* This claim must be re-verified on 4.7.

- **Baseline (no defence):** T3.2, T3.3, T3.4 × 20 reps × Opus 4.7 × {`none`, `medium`, `high`} = **180 runs**
- **Full intent-tracker:** T3.2, T3.3, T3.4 × 20 reps × Opus 4.7 × {`none`, `medium`, `high`} = **180 runs**
- Keep Haiku 4.5 + Sonnet 4.6 rows as-is (same prior data — they sit in the `none` effort column); add Opus 4.7 at three effort levels.
- **Stretch:** if `high`-effort Opus 4.7 materially changes baseline susceptibility, replicate the effort sweep on Sonnet 4.6 and Haiku 4.5 to test whether the effect is Opus-specific or a general capability-compliance story. Budget this as contingent on Test 7 results, not upfront.
- If the capability-compliance curve has shifted under reasoning effort (Opus 4.7 at `high` independently resists most attacks), flag it in the Discussion — it recasts the paper's narrative from "defences are needed because models always comply" to "defences are needed because the effort level operators actually deploy still complies".

Tables affected: `tab:cross-model-baseline`, `tab:cross-model-defended`, `tab:cross-model-scenario`.

### Test 8 — Adversarial Judge Robustness

Current claim: *"Even the best performer (Sonnet 4.6) catches only 7 of 12 adversarial cases."* If Opus 4.7 as judge beats Sonnet 4.6 on the adversarial set, the ranking changes.

- 12 adversarial cases × {Haiku 4.5, Sonnet 4.6, Opus 4.7} × {`none`, `medium`, `high`} = **108 evaluations** (cost is trivial).
- Compare catch rates against existing Sonnet 4.6 (7/12 at `none`) and Haiku 4.5 (1/12 at `none`) baselines.
- **This is where effort should matter most.** Adversarial cases are semantically benign on the surface — the tell is multi-step reasoning about *why* the action is being requested. If Haiku 4.5 at `high` effort jumps from 1/12 toward 7/12+, the "Haiku can't handle adversarials" finding becomes a deployment-configuration question, not a model-capacity question.
- Report Pareto frontier: catch rate vs latency vs $/case across the 3×3 grid.

### Test 1 — Combined Pipeline (judge evaluation subset)

Current recommendation: *"Claude Haiku 4.5 and Sonnet 4.6 tie at 90% accuracy ... Haiku 35% faster."* Opus 4.7 needs a row in `tab:judge-leaderboard`.

- 29 labelled cases × Opus 4.7 as judge × {`none`, `medium`, `high`} = **87 evaluations**
- Also add a `high`-effort row for Haiku 4.5 and Sonnet 4.6 on the same 29 cases (**58 evaluations**) — cheap, and lets `tab:judge-leaderboard` report per-model effort-level trade-offs in a single table.
- Record accuracy, FP, FN, ms/case *and* effort setting — add an `Effort` column to the leaderboard table.
- The recommended pipeline may now be (embedding + Model X at Effort Y); Config C's "Haiku 4.5 at default" may be beaten by "Haiku 4.5 at `high`" before needing to change model tier.
- Weigh accuracy gain against latency: `high`-effort Haiku may approach `none`-effort Opus in both dimensions, which would be the more operationally useful recommendation.

## Tests that do NOT need re-running

- **Test 5 (False positives):** Sonnet 4.6 agent + Haiku 4.5 judge — not affected unless the judge recommendation changes above. *Caveat:* if Test 1 adopts a `high`-effort judge, re-run the 10 legitimate tasks × 10 reps against that new judge — higher effort could shift the FP rate in either direction (more deliberation either catches edge cases correctly or overthinks benign actions into `drifting`).
- **Test 6 (Threshold sensitivity):** Embedding-layer analysis, model-agnostic.
- **Test 2 (Multi-turn trajectory):** Already run on Sonnet 4.6 + Haiku 4.5. The 4.7 picture is captured via Test 7.
- **Embedding model evaluation:** Unaffected.

## In-progress tests — design update

Tests 3 (statistical robustness), 4 (goal anchoring), 9 (latency) are still in progress. Update their planned matrices before execution:

- **Test 3:** If bimodality reps (90+) are planned on Opus, run on Opus 4.7 at `none` and `high` — bimodality itself may be an effort artefact.
- **Test 4:** Goal-anchoring is most interesting on the most susceptible agent/effort combo — pick whichever cell from Test 7 shows the highest hijack rate.
- **Test 9:** Must report judge latency and tokens/call as a grid over {model} × {effort}, not per-model. Section 7.4 pricing table becomes a pricing *surface*; the current single-row recommendation is incomplete without effort.

## Model version hygiene

- `test-framework/src/runner.ts:32` default is `claude-sonnet-4-6` — leave as-is for agent-side reproducibility of prior runs.
- Add `claude-opus-4-7` to the documented `--model` examples in `test-framework/README.md:72`.
- Bedrock pricing row for Opus 4.7 must be added to `tab:judge-cost` / `tab:total-cost` if it becomes the recommended judge.

## Execution order

1. **Plumbing first:** add `--thinking` / `--judge-thinking` flags in `runner.ts` and record effort in result JSON (½ day).
2. Test 8 adversarial × 3 models × 3 effort levels (108 cases, ~1–2 hr) — cheapest, highest info on whether effort matters at all.
3. Test 1 judge leaderboard with effort columns (~87–145 cases, ~2–3 hr).
4. If (2)/(3) indicate a judge swap OR an effort-level swap, re-run combined pipeline for the new (embedding, judge, effort) config.
5. Test 7 baseline + defended on Opus 4.7 × 3 effort levels (360 runs, ~12–18 hr) — the load-bearing one.
6. Update in-progress Tests 3/4/9 matrices before starting them, with effort as a first-class axis.

**Early-stop rule:** if Test 8 shows no effort sensitivity (catch rate moves <10% between `none` and `high` for all models), downgrade the effort sweep in Tests 1/7 to `none` + `high` only, not the full three-level grid. Don't collect data that won't change the story.
