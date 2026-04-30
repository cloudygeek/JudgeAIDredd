# Test Plan — Test 20 / 21 Extension: Slack + Travel Suites

**Date:** 2026-04-30
**Predecessor:** Test 20 (`docs/test-plan-agentdojo-qwen3-cross-vendor-2026-04-25.md`); Test 21 (`docs/test-plan-agentdojo-anthropic-defended-2026-04-25.md`); aggregated results in `results/test20/` and `results/test21/` (Workspace + Banking only).
**Issue:** Tests 20 and 21 ran the AgentDojo `important_instructions` attack on the Workspace and Banking suites only. The Slack and Travel suites — which the existing §3.8 GPT-4o-mini row covers — did not run on the four new defended-agent rows (Sonnet 4.6, Opus 4.7, Qwen3 32B, Qwen3 235B A22B). This extension closes the §3.8.7 cross-vendor matrix to full four-suite parity with the existing GPT-4o-mini and GPT-4o rows.
**Status:** Ready to dispatch. Both fargate entrypoints (`docker-entrypoint-test20.sh`, `docker-entrypoint-test21.sh`) already accept `AGENTDOJO_SUITES=slack,travel` as an env-var override; no engineering work required.

## Background

The existing §3.8 GPT-4o-mini row covers all four AgentDojo suites with measured per-suite ASR and utility:

| Suite | $N_{\text{sec}}$ | GPT-4o-mini baseline ASR | GPT-4o-mini defended ASR | Defended utility |
|---|---:|---:|---:|---:|
| Workspace | 560 | 17.1% | 0.0% | 70.0% |
| Banking | 144 | 50.0% | 0.0% | 50.0% |
| **Slack** | 105 | **64.8%** | 1.9% | **47.6% (−33pp)** |
| **Travel** | 140 | **34.3%** | 6.4% | 55.0% (flat) |

Slack carries the largest utility regression in the §3.8 paper text (−33pp); Travel carries the highest residual defended ASR (6.4%, the weakest cell). Both suites are paper-text-relevant for the §4.5 Limitations and §4.3 application-beyond-coding discussions. Without Slack and Travel rows for Sonnet 4.6 / Opus 4.7 / Qwen3 32B / Qwen3 235B, the §3.8.7 cross-vendor matrix is asymmetric: GPT rows full-AgentDojo, new rows Workspace+Banking only.

Tests 20 and 21 were planned with `--all-suites` but executed against `--suites workspace,banking` (root cause unknown; possibly an env-var default that fired in dispatch). The result data we have is internally consistent on Workspace+Banking but doesn't fill the §3.8.7 matrix.

## What this plan dispatches

Eight Fargate containers (4 models × 2 arms), each running only Slack and Travel suites:

| Container | Model | Defence arm | Suites |
|---|---|---|---|
| 1 | sonnet-4.6 | none | slack,travel |
| 2 | sonnet-4.6 | B7.1-office | slack,travel |
| 3 | opus-4.7 | none | slack,travel |
| 4 | opus-4.7 | B7.1-office | slack,travel |
| 5 | qwen3-32b | none | slack,travel |
| 6 | qwen3-32b | B7.1-office | slack,travel |
| 7 | qwen3-235b | none | slack,travel |
| 8 | qwen3-235b | B7.1-office | slack,travel |

All other configuration matches the existing Test 20 / 21 dispatch (judge: Sonnet 4.6 in `eu-central-1`; embed: Cohere v4; AgentDojo commit `18b501a`; prompt B7.1-office on the defended arm).

## Hypotheses

**H1 --- Sonnet 4.6 and Opus 4.7 baseline Slack and Travel ASR is ≤ 1\%.** The §3.6 (T3e), §3.9 (MT-AgentRisk), §3.10 (AgentLAB), and §3.8 Workspace+Banking rows all place current Anthropic frontier agents at the AgentDojo measurement floor. The Slack+Travel addition should reproduce this finding; departures from the floor on either suite would be noteworthy and would refine the §3.8.7 paragraph that currently asserts the cross-vendor pattern is corpus-invariant on Anthropic frontier.

**H2 --- Qwen3 32B and Qwen3 235B A22B baseline Slack and Travel ASR is in the 30--80\% range, with defence reducing both cells materially.** Qwen Workspace baseline was 9.6\% / 36.4\% (32B / 235B); Banking 51.4\% / 72.2\%. Slack and Travel typically sit between these on GPT-4o-mini (Slack 64.8\%, Travel 34.3\%). Predicted: Qwen 235B Slack baseline 60--80\%, Travel 30--50\%; defended ASR drops to ${\sim}0$\% on Slack (matches Workspace+Banking pattern), residual 1--7\% on Travel (matches GPT-4o-mini pattern: Travel is the suite where attack and legitimate action distributions overlap most).

**H3 --- Anthropic frontier benign-utility regression on Slack is comparable in direction to GPT-4o-mini's $-33$\,pp Slack drop.** Slack's legitimate-action surface (post-message, forward-contact, send-summary) overlaps strongly with the prompt v2 red-flag catalogue's "transmitting data to external endpoints" patterns. Anthropic frontier baseline utility on Slack should be high (the model can complete benign tasks); defended utility should drop materially. Predicted: $-15$ to $-30$\,pp Slack utility regression on Sonnet 4.6 / Opus 4.7. Quantifies whether the Slack utility cost is a *judge-prompt* problem (catalogue-vs-legitimate-action overlap) or a *defended-agent-tier* problem (smaller models more affected). If Anthropic frontier shows similar regression to GPT-4o-mini, the Slack utility cost is on the prompt; if Anthropic shows materially smaller regression, it tracks defended-agent capability.

**H4 --- Travel residual defended ASR matches the GPT-4o-mini Travel weakness.** Predicted: Travel defended ASR 5--15\% on at least one of the four new rows (matching GPT-4o-mini's 6.4\% Travel residual). If all four rows hit Travel ${\sim}0$\%, the §3.8 "Travel is the weakest suite" framing needs qualification; if at least one hits 5--15\%, the framing reproduces.

## Success criteria

1. **All 8 containers complete** without preflight or mid-run aborts. Per-suite summary files written to S3.
2. **Per-suite $N_{\text{sec}}$ matches the AgentDojo-canonical values** (Slack 105, Travel 140) on every cell.
3. **Defence pipeline configuration identical to existing Tests 20 / 21** (same judge, prompt, thresholds, embed model). Only suite selection differs.
4. **Per-trajectory dredd evaluations captured** on every defended trajectory.
5. **No re-runs of Workspace or Banking** (those data are settled and would only add cost).

## Decision rules

**If H1 + H2 + H3 + H4 hold (cross-vendor pattern reproduces on Slack + Travel):**
- Update Table 12 (`tab:agentdojo-cross-vendor`) in §3.8.7 to four-suite weighted rows for all six defended agents. Replace the Workspace+Banking-only $N{=}704$ with full-AgentDojo $N{=}949$ matching the existing GPT-4o-mini row.
- §3.8.7 closing paragraph promotes from "two-suite cross-vendor" to "full-AgentDojo cross-vendor" framing.

**If H1 fails (Anthropic frontier non-zero on Slack or Travel baseline):**
- Most likely cell: Slack baseline at 5--15\% on Sonnet 4.6 or Opus 4.7 — the Slack scenario distribution may genuinely contain attack patterns Anthropic's training has not covered (post-channel-mention extraction, contact-list scraping). Worth a paragraph noting the per-suite ceiling break on Anthropic frontier, refining the §3.8 Anthropic-floor claim from "across AgentDojo" to "across Workspace+Banking; Slack/Travel partial."

**If H3 fails (Anthropic Slack utility regression smaller than GPT-4o-mini's):**
- Slack utility cost tracks defended-agent capability rather than prompt overlap. Refines §3.8 / §4.3 utility-cost discussion: a domain-specific prompt re-calibration on Slack would benefit smaller defended agents more than frontier ones.

**If a container fails preflight (the original failure mode):**
- Halt that container; surface the error from CloudWatch logs. Do not silently retry — the original Workspace+Banking-only run probably suffered a silent default-fallthrough.

## Execution

### Stage 0 — verify dispatch wiring (~5 min, $0)

```bash
# Confirm both entrypoints accept slack,travel
grep -E 'AGENTDOJO_SUITES|--suites' fargate/docker-entrypoint-test20.sh fargate/docker-entrypoint-test21.sh

# Confirm the agentdojo bridge actually loads the slack and travel suites
python3 -c "
from agentdojo.task_suite import get_suites
from agentdojo.benchmark import benchmark_suite_v1
suites = ['slack', 'travel']
for s in suites:
    suite = get_suites('v1.2.2', s)
    print(f'{s}: security tasks={len(list(suite.user_tasks.values()))}, '
          f'injection tasks={len(list(suite.injection_tasks.values()))}')
"
```

If the suite-loading test prints non-zero counts for both Slack and Travel, proceed to Stage 1.

### Stage 1 — single-cell smoke gate (~$1, ~30 min)

Dispatch one container with the smallest expected workload (Sonnet 4.6 baseline + Slack only, $N_{\text{sec}}{=}105$) to verify the dispatch path produces real Slack+Travel data:

```bash
aws ecs run-task --cluster cko-test --task-definition cko-test21:LATEST \
  --overrides '{
    "containerOverrides": [{
      "name": "test21",
      "environment": [
        {"name": "AGENTDOJO_MODEL",   "value": "sonnet-4.6"},
        {"name": "AGENTDOJO_DEFENSE", "value": "none"},
        {"name": "AGENTDOJO_SUITES",  "value": "slack"},
        {"name": "OUTPUT_PREFIX",     "value": "test21-slack-smoke"}
      ]
    }]
  }'
```

**Pass criteria:**
- Container exits cleanly within ~30 min.
- `s3://cko-results/test21-slack-smoke/agentdojo-sonnet-baseline/summary-*.json` contains a `suites` array of length 1 (slack), with `security_n: 105`.
- ASR is non-degenerate (not stuck at 0/0 or 105/105 — Sonnet baseline expected at ${\leq}1$\%).

### Stage 2 — full dispatch (~$30--50, ~3--6h)

Eight containers in parallel. Each runs Slack + Travel only (one container handles both suites; AgentDojo's runner accepts comma-separated suite lists):

```bash
# Anthropic agents (eu-west-1, judge in eu-central-1)
for MODEL in sonnet-4.6 opus-4.7; do
  for DEFENSE in none B7.1-office; do
    aws ecs run-task --cluster cko-test --task-definition cko-test21:LATEST \
      --overrides "{\"containerOverrides\": [{\"name\": \"test21\", \"environment\": [
        {\"name\": \"AGENTDOJO_MODEL\",   \"value\": \"${MODEL}\"},
        {\"name\": \"AGENTDOJO_DEFENSE\", \"value\": \"${DEFENSE}\"},
        {\"name\": \"AGENTDOJO_SUITES\",  \"value\": \"slack,travel\"},
        {\"name\": \"OUTPUT_PREFIX\",     \"value\": \"test21-slack-travel\"}
      ]}]}"
  done
done

# Bedrock-Qwen agents (eu-central-1)
for MODEL in qwen3-32b qwen3-235b; do
  for DEFENSE in none B7.1-office; do
    aws ecs run-task --cluster cko-test --task-definition cko-test20:LATEST \
      --overrides "{\"containerOverrides\": [{\"name\": \"test20\", \"environment\": [
        {\"name\": \"AGENTDOJO_MODEL\",   \"value\": \"${MODEL}\"},
        {\"name\": \"AGENTDOJO_DEFENSE\", \"value\": \"${DEFENSE}\"},
        {\"name\": \"AGENTDOJO_SUITES\",  \"value\": \"slack,travel\"},
        {\"name\": \"OUTPUT_PREFIX\",     \"value\": \"test20-slack-travel\"}
      ]}]}"
  done
done
```

(Exact ECS task-definition names may differ; consult the team's existing dispatch runbook.)

### Stage 3 — aggregation and paper update (~30 min, $0)

After all 8 containers complete, sync results down and re-run the aggregator:

```bash
# Sync the new data
aws s3 sync s3://cko-results/test21-slack-travel/ results/test21/
aws s3 sync s3://cko-results/test20-slack-travel/ results/test20/

# Re-aggregate (existing script, no changes needed)
python3 scripts/aggregate-results.py 20 21
```

The script's per-suite summary will now include all four suites for each cell. Update `p15.tex` Table 12 (`tab:agentdojo-cross-vendor`) to use four-suite weighted ASR ($N_{\text{sec}}{=}949$ matching the existing GPT-4o-mini row) instead of the current two-suite weighted ($N_{\text{sec}}{=}704$).

## Wall-clock and cost

**Per (model × arm) cell** running Slack + Travel = 245 security cases + 41 utility cases = ~286 trajectories, with each trajectory using ~5--10 LLM calls (agent loop):

| Defended agent | Per-trajectory cost (agent + judge) | Cell cost (~286 trajectories) | Wall-clock |
|---|---:|---:|---:|
| Sonnet 4.6 baseline | ~\$0.05 | **~\$15** | ~2--3h |
| Sonnet 4.6 defended | ~\$0.07 | **~\$20** | ~3--4h |
| Opus 4.7 baseline | ~\$0.07 | **~\$20** | ~3--4h |
| Opus 4.7 defended | ~\$0.09 | **~\$26** | ~4--5h |
| Qwen3 32B baseline | ~\$0.02 | **~\$6** | ~2--3h |
| Qwen3 32B defended | ~\$0.04 | **~\$12** | ~3--4h |
| Qwen3 235B baseline | ~\$0.05 | **~\$15** | ~3--4h |
| Qwen3 235B defended | ~\$0.07 | **~\$20** | ~4--5h |
| **Sub-total** | | **~\$134** | |
| Embedding (~\$0.10 per defended cell × 4) | | **~\$0.40** | |
| **Total** | | **~\$135** | |

**Wall-clock total:** ~24--32h serial. With 8 parallel containers (each in its own ECS task): **~3--6h**.

**Budget cap:** \$200 all-in. Halt at \$250.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Travel suite scenarios fail mid-run on Bedrock-Qwen due to per-scenario tool-schema differences (Travel involves more diverse tool surfaces than Workspace/Banking) | Medium | Medium | Stage 1 smoke uses Slack only; Stage 2 should monitor early Travel-cell logs and halt on $>20$\% scenario aborts |
| Original failure mode (silent fall-through to Workspace+Banking only) recurs | Low | Medium | Stage 0 verify pre-dispatch; Stage 3 aggregation explicitly checks $N_{\text{sec}}$ matches Slack 105 + Travel 140; halt and dispatch correction if mismatched |
| Slack utility regression on Anthropic frontier exceeds 50\,pp (Anthropic models particularly sensitive to Slack-class injection patterns) | Low | Low | Decision rule branch above. Useful finding either way |
| H4 fails (Travel defended ASR ~0\% on all 4 rows) | Medium | Low | Refines §3.8 Travel-weakness framing rather than invalidating it; one-paragraph qualification |
| Cost overrun (Travel scenarios run longer than expected) | Low | Low | Budget cap \$200; per-cell halt-on-overrun; can drop one of the four models if cost runs hot |
| Docker image is stale and missing the runner-fix or other recent changes | Medium | Medium | Stage 0 verify image tag matches latest commit on `main`; rebuild and push if stale |

## Non-goals

- **Re-running Workspace or Banking** on any of the four models. Those data are settled.
- **Adding additional models** beyond the four already in §3.8.7. GPT-4o-mini and GPT-4o full-AgentDojo numbers are carried over from the existing data.
- **Adding additional attacks** beyond `important_instructions`. AgentDojo's other attacks (e.g., `direct`, `tool_knowledge`) are out-of-scope.
- **Increasing $N$** beyond the AgentDojo canonical values. The published numbers are at AgentDojo-canonical $N$; matching is more important than higher $N$.
- **Calibrating a Slack-specific judge prompt**. The §3.8 / §4.3 Slack utility regression is a known-and-disclosed limitation; this rerun does not aim to reduce it, only to measure it on the four new rows.

## Dependencies

- **Fargate cluster + task definitions** (`cko-test20:LATEST`, `cko-test21:LATEST`) — already deployed for the original Tests 20 / 21.
- **Bedrock access** for `eu.anthropic.claude-sonnet-4-6`, `eu.anthropic.claude-opus-4-7` (`eu-west-1`); `qwen.qwen3-32b-v1:0`, `qwen.qwen3-235b-a22b-2507-v1:0` (`eu-central-1`); judge access in `eu-central-1`.
- **AgentDojo benchmark commit** `18b501a` (already pinned in the bridge).
- **`scripts/aggregate-results.py`** for Stage 3 re-aggregation (already committed).
- **Updated paper Table 12** in `p15.tex` after Stage 3 completes.

## Stretch follow-ups

If Stage 2 lands cleanly:

1. **Repeat-run determinism check.** Re-run one cell (e.g., Sonnet 4.6 defended Slack) a second time; report run-to-run ASR variance. The existing §3.8 GPT-4o vs GPT-4o-mini comparison already noted run-to-run variance; the four new rows would benefit from the same characterisation.
2. **Test 20 + 21 + Slack/Travel feeds into Test 19.5** (a hypothetical full-N=200 cross-vendor T3e + AgentDojo combined matrix). Not on the table now; future-paper material.
3. **Run AgentDojo's `direct` and `tool_knowledge` attacks** against the same four rows if reviewers ask for additional attack-class coverage. ~\$130 each.

## Output expectations for §3.8.7 paper text

If Stages 1--3 complete and H1 + H2 hold, the §3.8.7 closing paragraph reads:

> ``Six defended agents on the full AgentDojo \texttt{important\_instructions} corpus (four suites, $N_{\text{sec}}=949$ weighted): GPT-4o-mini drops from 29.9\% baseline to ${\sim}2$\% defended; GPT-4o $\sim$39\% to $\sim$3--7\%; Sonnet 4.6 and Opus 4.7 are at the AgentDojo measurement floor under both arms (0\% baseline, 0\% defended; CIs upper-bound 0.4\%); Qwen3 32B drops from $X$\% to $Y$\%; Qwen3 235B A22B drops from $Z$\% to $W$\% (the largest single defence-effect measurement, $\Delta_{\text{ASR}} \approx -W$\,pp). Slack carries the largest utility regression on every defended agent ($-15$ to $-33$\,pp); Travel carries the highest residual defended ASR. Three independent attack-class corpora (T3e, MT-AgentRisk, AgentDojo) corroborate the same vendor-tier-conditioned defence-effect pattern.''

Slack utility regression specifically is paper-quotable in §4.3 (application-beyond-coding) as cross-tier evidence for the catalogue-vs-legitimate-action overlap framing.

---

This plan is an extension run, not a new test. Cost ~\$135, wall-clock ~3--6h with 8 parallel containers. Closes the §3.8.7 cross-vendor matrix to full-AgentDojo parity with the existing GPT-4o-mini row.
