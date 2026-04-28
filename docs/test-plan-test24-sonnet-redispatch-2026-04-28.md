# Test Plan — Test 24 Sonnet 4.6 Re-Dispatch (Missing Anthropic Row)

> **⚠️ SUPERSEDED — kept for audit trail only.**
>
> This plan was written 2026-04-28 from an outside-in inspection of `results/test24/` that
> mis-diagnosed the root causes for both Opus 4.7 (98% FAILED) and Sonnet 4.6 (no real
> data). The actual re-dispatch was already in flight on Fargate containers `bedt5–bedt8`
> (v0.1.207) when this plan was committed, and the actual root causes — documented in
> `docs/test24-findings-2026-04-28.md` (Findings 2, 3, 4) — are different from this plan's
> framing:
>
> - **Opus 4.7**: temperature API parameter rejection, **not** step-budget cap.
>   Fixed in v0.1.206 via `MODELS_NO_TEMPERATURE` in `llm_client.py`.
> - **Sonnet 4.6**: 80-step budget exhaustion + per-scenario over-persistence (34h
>   for 318/820 scenarios), **not** "didn't dispatch". Fixed in v0.1.206 via per-model
>   step budget (Sonnet/Opus = 30 steps) + repeated-error early termination.
> - **All v0.1.202 defended runs**: YAML crash at scenario 404 due to a corrupt
>   `turns.yml` containing `*** End Patch`. Fixed in v0.1.207 via per-scenario try/except
>   plus removal of the corrupt line.
>
> This plan's Stage 0 verify (`AGENT_MODELS` registration check) was the wrong question;
> Stage 1's local smoke-budget assumption (`total_steps < 30 on at least 5 of 10`)
> contradicts the actual fix (Sonnet/Opus capped at 30, others at 80); H3's framing
> ("Sonnet 4.6 FAILED rate 40--60%") is not the right falsifier because Opus 4.7's
> 98% FAILED was an API error, not behavioural unclassifiability.
>
> **For the live status of the bedt5–bedt8 re-runs**, see the "In-progress re-runs
> (v0.1.207)" table at the bottom of `docs/test24-findings-2026-04-28.md`. **For the
> §3.8 paper-text framing the completed re-runs will support**, see Findings 6, 7, 8
> in the same doc.
>
> The plan content below is preserved verbatim as a record of what we believed when
> we wrote it. Do not act on its execution sections.

---

**Date:** 2026-04-28
**Predecessor:** Test 24 (`docs/test-plan-mt-agentrisk-2026-04-26.md`); findings note `docs/test24-findings-2026-04-28.md`.
**Issue:** Test 24's Fargate dispatch covered four models (`haiku-4.5`, `gpt-4o-mini`, `opus-4.7`, `qwen3-coder`) but **Sonnet 4.6** — the most paper-comparable Anthropic row to the source paper's headline Claude 4.5 Sonnet number — never produced real data. Only a stub directory exists at `results/test24/sonnet-{baseline,defended}/test24-sonnet-4.6-{none,intent-tracker}/` with seven placeholder files containing all-zero summaries.
**Status:** Ready to dispatch. The runner code, dataset, MCP infrastructure, and Fargate entrypoint are all known-good (proven by haiku-4.5 / gpt-4o-mini / qwen3-coder runs that produced 319 trajectories per cell). This is purely re-running the missing two containers.

## Background

Test 24's plan covered five defended-agent rows: Haiku 4.5, Sonnet 4.6, Opus 4.7, GPT-4o-mini, Qwen Coder 480B. The actual Fargate dispatch covered four, omitting Sonnet 4.6. The omission is most-likely either:
1. The dispatch script's model list didn't include `sonnet-4.6`, or
2. The Sonnet container failed at preflight and the failure was silent / not retried.

The stub `sonnet-baseline.test24-sonnet-4.6-baseline/` directory contains a summary file with `n_total: 7`, dated `2026-04-27T13:01:02Z`. The other models' real-run directories started later (`2026-04-27T19:57:43` for haiku). The Sonnet stub is from a separate (probably earlier) run that broke before the dataset was vendored properly. It was committed alongside the real run's results and should be cleaned up (Finding 1 of `test24-findings-2026-04-28.md`).

## Why this matters

The source paper (arXiv:2602.13379) reports Claude 4.5 Sonnet at +27pp ASR multi-turn vs.\ single-turn — its strongest published cross-corpus measurement. Test 24's H1 explicitly stated:

> H1 — Sonnet 4.6 baseline ASR matches the source paper's published Claude 4.5 Sonnet number within Wilson 95% CI.

Without Sonnet 4.6 data, **H1 is untestable**. The §3.8 paper text would either:
- Have to skip the source-paper-reproduction sentence entirely, weakening the §3.8 narrative, or
- Quote a different model (Haiku 4.5 at 43.9% baseline / 28.0% defended) as the headline, which is a less-direct cross-paper comparison.

Re-dispatching Sonnet 4.6 closes this gap.

## What this plan dispatches

Two Fargate containers, identical to the original Test 24 dispatch except for the model:

| Container | Model | Defence arm | Output bucket prefix |
|---|---|---|---|
| 1 | `sonnet-4.6` | `none` | `s3://cko-results/test24/sonnet-baseline/` |
| 2 | `sonnet-4.6` | `intent-tracker` | `s3://cko-results/test24/sonnet-defended/` |

All other configuration matches the original Test 24:
- `--scenarios all` (820 scenarios via the vendored dataset)
- `--max-turns 8`
- `--benchmark-judge-model eu.anthropic.claude-sonnet-4-6` (judge in `eu-central-1`)
- `--dredd-judge-model eu.anthropic.claude-sonnet-4-6` (defended arm only)
- `--dredd-judge-prompt B7.1`
- `--embed-model eu.cohere.embed-v4:0`
- `MODEL_STEP_BUDGET["sonnet-4.6"] = 30` already set in `run_benchmark.py:62` — appropriate cap

## Hypotheses

**H1 (carried over from Test 24 plan) — Sonnet 4.6 baseline aggregate ASR (on classifiable subset) lands within ±15pp of the source paper's published Claude 4.5 Sonnet multi-turn number.** Per Finding 4 of `test24-findings-2026-04-28.md`, ASR is quoted on the COMPLETE+REJECT subset, excluding FAILED. Predicted: Sonnet 4.6 baseline ASR 30--55% on the classifiable subset (within range of the source paper's reported per-tool-surface average).

**H2 — Sonnet 4.6 defended ASR drops by ${\geq}10$pp from baseline.** §3.6 Test 19 showed Sonnet 4.6 refuses T3e at the floor; §3.7 AgentDojo cross-vendor patterns show Anthropic agents at lower baseline than OpenAI/Qwen. AgentLAB's multi-turn tool-grounded attacks span both attack-class types. Predicted: defended Sonnet 4.6 ASR ≤ baseline − 10pp on classifiable subset.

**H3 — Sonnet 4.6 FAILED rate is comparable to haiku-4.5's 52--53%, NOT opus-4.7's 98%.** This is the falsifier for the budget-interaction concern: if Sonnet 4.6 also returns ≥90% FAILED, Finding 2's diagnosis ("opus-4.7's 98% FAILED is a budget cap interaction") needs revision because Sonnet 4.6 is on the same `MODEL_STEP_BUDGET = 30` line. Predicted: Sonnet 4.6 FAILED rate 40--60%.

**H4 — Sonnet 4.6 baseline FAILED rate matches its defended FAILED rate (within ±5pp).** FAILED is environmental (Finding 4) — sandbox refusal of harmful tool calls. The defence's per-tool-call gate happens *after* the sandbox decides whether the tool can run, so FAILED rate should be approximately defence-arm-invariant. Predicted: |FAILED_baseline − FAILED_defended| ≤ 5pp.

## Success criteria

1. **Both containers complete** without preflight errors or mid-run aborts. Run logs show `Loaded 820 scenarios across surfaces` and proceed past at least 200 scenarios in the per-scenario inner loop.
2. **Per-cell file count = 319** for both arms (matches haiku/gpt-4o-mini/qwen3-coder).
3. **FAILED rate ≤ 70%** (not the 98% opus-4.7 pathology).
4. **Defence pipeline configuration identical to Test 24 original** (same judge, prompt, thresholds, embed model). Only the dispatched model differs.
5. **Per-trajectory `dredd_evaluations` non-empty** on every defended trajectory.

## Decision rules

**If H1--H2 hold (Sonnet 4.6 baseline reproduces source paper; defence drops ASR ≥10pp):**
- §3.8 paper text quotes Sonnet 4.6 as the headline source-paper-reproduction row. Other working models (haiku, gpt-4o-mini, qwen3-coder) are corroborating cross-vendor rows.
- §3.8 cross-vendor matrix becomes 4 of 5 planned (still missing Opus 4.7 pending Finding 2 diagnosis).

**If H3 fails (Sonnet 4.6 also returns ≥90% FAILED):**
- The `MODEL_STEP_BUDGET = 30` setting is too low for *recent Anthropic models with extended reasoning*, not specifically opus-4.7. Both Sonnet 4.6 and Opus 4.7 may need a wider budget. Diagnose `total_steps` distribution on Sonnet 4.6's runs; if it's clamped at 30, widen to 60 and re-run both Sonnet 4.6 and Opus 4.7. ~$30, ~5h.

**If H4 fails (FAILED rate differs materially between arms):**
- Surprising and worth diagnosis: the dredd defence interacts with the sandbox in a way that changes which scenarios reach a decision state. Inspect `dredd_evaluations` per trajectory to see if dredd's denials are causing the agent to abort earlier.

**If preflight fails or the container crashes mid-run:**
- Halt. Surface the error from the container log; this is what likely happened to the original Sonnet 4.6 dispatch and should not be silently retried again.

## Execution

### Stage 0 — verify dispatch infrastructure (~5 min, $0)

```bash
# Confirm the Test 24 entrypoint accepts sonnet-4.6 in its model list
grep -E '(sonnet-4|MODEL_BUDGET|sonnet)' fargate/docker-entrypoint-test24.sh | head -5
grep -E 'sonnet|AGENT_MODELS' benchmarks/mt_agentrisk/llm_client.py | head -10

# Confirm the model is in AGENT_MODELS
python3 -c "from benchmarks.mt_agentrisk.llm_client import AGENT_MODELS; print('sonnet-4.6:', AGENT_MODELS.get('sonnet-4.6', 'NOT REGISTERED'))"

# Confirm the step-budget table includes sonnet-4.6
python3 -c "from benchmarks.mt_agentrisk.run_benchmark import MODEL_STEP_BUDGET; print(MODEL_STEP_BUDGET)"
```

If any of the above returns `NOT REGISTERED` or the budget table lacks `sonnet-4.6`, fix the missing entry before dispatching. If everything checks out, move to Stage 1.

### Stage 1 — single-container smoke gate (~$2, ~30 min)

Dispatch one container with a 10-scenario subset to verify the configuration runs end-to-end on Sonnet 4.6. The smoke uses Sonnet 4.6 baseline (no defence) on the smallest subset:

```bash
# Local smoke (if the dataset is fully vendored locally — Finding 1 of test24-findings)
DATASET_ROOT=/path/to/full/mt-agentrisk \
AWS_REGION=eu-west-1 JUDGE_REGION=eu-central-1 \
  python3 benchmarks/mt_agentrisk/run_benchmark.py \
    --models sonnet-4.6 \
    --defences none \
    --scenarios 10-pilot \
    --max-turns 8 \
    --random-seed 42 \
    --output-dir results/test24-sonnet-smoke/ \
    --benchmark-judge-model eu.anthropic.claude-sonnet-4-6 \
    --benchmark-judge-region eu-central-1
```

**Pass criteria:**
- 10 trajectories complete
- At least 3 of 10 are classifiable (COMPLETE or REJECT, not FAILED)
- No `ValidationException` errors
- `total_steps` < 30 on at least 5 of 10 (proves budget cap isn't biting Sonnet 4.6 the way Finding 2 suggests it bites Opus 4.7)

### Stage 2 — Fargate full re-dispatch (~$15, ~2--3h)

Two Fargate tasks, run in parallel (independent containers):

```bash
# Container 1: Sonnet 4.6 baseline
aws ecs run-task \
  --cluster cko-test24 \
  --task-definition cko-test24:LATEST \
  --overrides '{
    "containerOverrides": [{
      "name": "test24",
      "environment": [
        {"name":"MODEL", "value":"sonnet-4.6"},
        {"name":"DEFENCE", "value":"none"},
        {"name":"OUTPUT_PREFIX", "value":"sonnet-baseline"}
      ]
    }]
  }'

# Container 2: Sonnet 4.6 defended
aws ecs run-task \
  --cluster cko-test24 \
  --task-definition cko-test24:LATEST \
  --overrides '{
    "containerOverrides": [{
      "name": "test24",
      "environment": [
        {"name":"MODEL", "value":"sonnet-4.6"},
        {"name":"DEFENCE", "value":"intent-tracker"},
        {"name":"OUTPUT_PREFIX", "value":"sonnet-defended"}
      ]
    }]
  }'
```

(Exact ECS task-definition / cluster names may differ; consult the team's existing dispatch script. The configuration is `(MODEL=sonnet-4.6, DEFENCE in {none, intent-tracker})` — that's the variable surface.)

### Stage 3 — comparison aggregation (~10 min, $0)

After both containers complete, aggregate:

```python
import json, glob, os
from collections import Counter, defaultdict

# Pull Sonnet 4.6 cells alongside the existing 4 working models
WORKING = ['haiku-4.5', 'gpt-4o-mini', 'qwen3-coder', 'sonnet-4.6']
cells = defaultdict(list)
for cell_dir in glob.glob('results/test24/test24-*/'):
    cell = os.path.basename(cell_dir.rstrip('/'))
    rest = cell.removeprefix('test24-')
    if rest.endswith('-baseline'): model, arm = rest[:-9], 'baseline'
    elif rest.endswith('-intent-tracker'): model, arm = rest[:-15], 'defended'
    else: continue
    if model not in WORKING: continue
    for f in glob.glob(f'{cell_dir}/t24-*.json'):
        if 'summary' in f: continue
        try: cells[(model,arm)].append(json.load(open(f)))
        except: pass

# Print the §3.8 cross-vendor matrix
# Per-model: classifiable ASR (excluding FAILED) baseline → defended → Δ
# Plus: per-tool-surface breakdown for each Sonnet 4.6 row
```

The script lands in `scripts/aggregate-test24.py` and produces `docs/test24-with-sonnet-findings.md` containing the closed-cross-vendor 4-row table.

## Wall-clock and cost

| Stage | Cost | Wall-clock |
|---|---:|---:|
| Stage 0 verify | $0 | ~5 min |
| Stage 1 smoke (optional, recommended) | ~$2 | ~30 min |
| Stage 2 Fargate dispatch (2 containers, parallel) | ~$13 | ~2--3h |
| Stage 3 aggregation | $0 | ~10 min |
| **Total** | **~$15** | **~3h** |

Budget cap: $25 all-in. Halt at $30.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `sonnet-4.6` not registered in `AGENT_MODELS` (most-likely root cause of original silent failure) | Medium | Medium | Stage 0 verify catches this. Add the entry before dispatching |
| Sonnet 4.6 hits the same step-budget pathology as opus-4.7 (98% FAILED) | Low--Medium | Medium | Stage 1 smoke catches this in 30 min. If it does, widen budget to 60 (matches `MODEL_STEP_BUDGET`'s default `max_turns × 10 = 80` for unlisted models — opus-4.7 ironically may be benefiting from being explicitly capped at 30 vs. Sonnet 4.6 being uncapped at 80) |
| Cross-region inference profile required: `eu-west-1` Anthropic + `eu-central-1` judge | Low | Low | Existing Test 24 dispatch already uses this. No change |
| Sonnet 4.6 quota exhaustion at Bedrock during a 3h run | Low | Medium | Use the same `inference-profile` that haiku-4.5 used; spread across `eu-west-1` and `eu-west-2` if both available |
| Container exits silently without writing results (the original failure mode) | Low | High | Add explicit S3 upload-confirmation check at the end of `docker-entrypoint-test24.sh` if not already present; verify after dispatch via `aws s3 ls s3://cko-results/test24/sonnet-baseline/` |
| Fargate task fails preflight (Bedrock or S3) and exits before any work | Low | Low | Stage 0 verify already catches local config issues; remaining risk is platform-side and surfaces in Cloudwatch logs |

## Non-goals

- **Re-running other models.** Haiku 4.5, GPT-4o-mini, and Qwen Coder data is good; opus-4.7 needs a separate diagnosis-and-rerun plan (Finding 2 of test24-findings).
- **Adding canary-server routing to MT-AgentRisk scenarios.** Strict-metric ASR is a separate engineering item. Test 24's permissive judge metric is a known caveat (Finding 4); §3.8 paper text discloses it.
- **Increasing N.** 319 scenarios per cell is the same as the other working models; cross-model consistency is more important than higher-N on Sonnet alone.
- **Upgrading the tool sandbox.** Postgres-mcp / Chromium installation is Finding 4's optional follow-up; not on the Sonnet re-dispatch path.

## Dependencies

- **Vendored MT-AgentRisk dataset** at `/app/datasets/mt-agentrisk/workspaces/` (already in the Fargate image; preflight reports 1100 task/turns files for the working models).
- **MCP infrastructure**: filesystem (14 tools), browser (21 tools), notion (22 tools); postgres skipped per existing run logs.
- **Bedrock access** for `eu.anthropic.claude-sonnet-4-6` in `eu-west-1` (agent) and `eu-central-1` (judge).
- **`AGENT_MODELS` registration** for `sonnet-4.6` in `benchmarks/mt_agentrisk/llm_client.py` — VERIFY in Stage 0.
- **`MODEL_STEP_BUDGET` entry** for `sonnet-4.6` in `benchmarks/mt_agentrisk/run_benchmark.py:62` — already present (`30`).

## Stretch follow-ups

If the Sonnet 4.6 re-dispatch lands cleanly:

1. **Diagnose opus-4.7's FAILED rate** (Finding 2 of test24-findings). If H3 above shows Sonnet 4.6 doesn't hit the same pathology, the budget-cap hypothesis for opus-4.7 stands and we'd widen its cap and re-run.
2. **Source-paper number reproduction check.** Compare Sonnet 4.6's per-tool-surface ASR distribution against the source paper's reported numbers; if any surface deviates by > 20pp, surface as a methodological note.
3. **Update §3.8 with the 4-row cross-vendor matrix** (haiku, sonnet, gpt-4o-mini, qwen3-coder; opus-4.7 deferred). 5-row matrix becomes possible after Finding 2 diagnosis.
4. **Add Sonnet 4.5 as a sanity check** — the source paper's exact model. ~$15 additional dispatch. Not required for §3.8 but tightens the cross-paper comparison.

## Output expectations for §3.8 paper text

If Stages 1--3 complete and H1+H2 hold, §3.8 reads:

> ``§3.8 — MT-AgentRisk Cross-Vendor Multi-Turn Tool-Grounded Validation. We dispatched MT-AgentRisk's full 820-scenario test split against four defended-agent rows: Sonnet 4.6, Haiku 4.5, GPT-4o-mini, and Qwen3 Coder 30B. ASR is quoted on the classifiable subset (COMPLETE+REJECT, excluding FAILED scenarios where the tool sandbox prevented the agent from reaching a decision state — see §4.5). Sonnet 4.6 baseline ASR was $X$\% [a, b], dropping to $Y$\% [a, b] under the dredd PreToolUse pipeline, a $\Delta_{\text{ASR}} = -Z$\,pp reduction. Haiku 4.5 showed $-15.9$\,pp; GPT-4o-mini $-15.2$\,pp; Qwen3 Coder $-7.2$\,pp. The Sonnet 4.6 baseline ($X$\%) is within Wilson 95\% CI of the source paper's published Claude 4.5 Sonnet multi-turn ASR ($+27$\,pp shift on top of single-turn baselines), confirming reproduction of the published headline within our harness. Cross-vendor differentiation matches §3.6 (T3e) and §3.7 (AgentDojo): Anthropic agents have lower baseline ASR than OpenAI / Qwen agents on multi-turn tool-grounded attacks, and the dredd PreToolUse pipeline reduces ASR materially across all measured agents.''

The Opus 4.7 row is deferred to a follow-up note pending Finding 2 diagnosis.

---

This plan is intentionally narrow: a missing-row re-dispatch on Test 24 with no engineering changes beyond a Stage 0 verification step. Its purpose is to close the §3.8 cross-vendor matrix's most-paper-comparable gap.
