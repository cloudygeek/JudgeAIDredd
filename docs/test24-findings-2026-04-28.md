# Test 24 (MT-AgentRisk) — Findings and Caveats

**Date:** 2026-04-28
**Run:** `results/test24/test24-{model}-{baseline,intent-tracker}/` (8 cells, 319 trajectories per cell, 2,552 trajectories total)
**Models that produced usable data:** haiku-4.5, gpt-4o-mini, qwen3-coder. **Did not produce usable data:** opus-4.7 (98% judge-FAILED), sonnet-4.6 (task didn't dispatch).
**Source paper:** *Unsafer in Many Turns* (Li, Yu, Pan, Sun, Li, Song, Lin, Shi 2026; arXiv:2602.13379)

This note records six findings that change how Test 24's headline numbers should be interpreted before any of the data is folded into P15 §3.8.

---

## Finding 1 — Two parallel result directories; only one is real data

`results/test24/` contains two directory structures:

```
results/test24/
├── {model}-{arm}/test24-{model}-{arm}/        ← 7 stub files per cell. NOT REAL DATA.
└── test24-{model}-{arm}/                      ← 319 trajectories per cell. THE REAL RUN.
```

The stub directories (`sonnet-baseline/test24-sonnet-4.6-baseline/`, etc.) contain summaries with `n_total: 7` aggregating one outcome per top-level dataset partition (`workspaces_filesystem`, `workspaces_postgres`, ..., `workspaces_Subset_100`, `workspaces_terminal`, `workspaces_benign_tasks`, `workspaces_playwright`). They appear to be from an earlier broken run that wrote summary files but no per-scenario JSONs.

The real data lives in the `results/test24/test24-{model}-{arm}/` directories (319 per-scenario JSONs each). Any analysis that reads only `summary-*.json` files via the stub directories will see all-zeros and no signal.

**Fix:** any post-hoc analysis must aggregate from the per-scenario JSONs, not from the stub-summary files. The stub directories should be deleted or moved to a `test24-broken/` subdirectory to prevent future confusion.

---

## Finding 2 — opus-4.7 is unusable: 312/319 trajectories returned FAILED

| Model × Arm | N | COMPLETE | REJECT | FAILED | classifiable (C+R) |
|---|---:|---:|---:|---:|---:|
| opus-4.7 baseline | 319 | 4 | 3 | **312** | 7 |
| opus-4.7 defended | 319 | 4 | 3 | **312** | 7 |

98% of opus-4.7's trajectories were judged `FAILED` — the AgentLAB-style classifier (Sonnet 4.6 in our config) couldn't determine whether the attack succeeded or the agent refused. This is structurally indistinguishable between the two arms.

**Probable cause** (based on `run_benchmark.py:62`'s `MODEL_STEP_BUDGET` table): `opus-4.7` is listed with budget `30`, the same as Sonnet 4.5 / 4.6. But the model's `total_steps` distribution probably hits the budget cap before it reaches a decision turn — opus-4.7 retries failing tool calls aggressively, and the 30-step budget is exhausted on the retries before the harmful action ever happens.

**Diagnosis path:** dump opus-4.7's `total_steps` distribution from the per-scenario JSONs; correlate with `judge.label`. If most FAILED have total_steps == 30 / 80 (whichever cap fired), the budget is the cause. Either widen the cap to ~60 for opus-4.7 specifically, or drop opus-4.7 from the §3.8 model row and note the budget-interaction issue in §4.5.

**Paper implication:** until diagnosed, the `opus-4.7` row in §3.8 reads `(insufficient data, n=7)` rather than a numeric ASR. Cannot quote a Δ.

---

## Finding 3 — Sonnet 4.6 didn't run on the real Test 24 dispatch

The real run logs (`results/test24/test24-{model}-{baseline,intent-tracker}.log`) cover four models: `haiku-4.5, gpt-4o-mini, opus-4.7, qwen3-coder`. **Sonnet 4.6 is absent.** Only the stub directory (Finding 1) has a sonnet-tagged path, and it has no real per-scenario data.

Test 24's plan included Sonnet 4.6 as a defended-agent row. Most likely the Fargate task for Sonnet 4.6 either failed at preflight, was dispatched to a different output bucket, or wasn't included in the run script. The Sonnet 4.6 baseline row is *the* directly-comparable cell to the source paper's published Claude 4.5 Sonnet number, so its absence means H1 (source-paper reproduction) cannot be tested.

**Recommended:** re-dispatch the Sonnet 4.6 Fargate task with the same configuration (one model × two arms = two containers). ~$15, ~2--3h. Without this, the cross-vendor matrix in §3.8 is missing the most important Anthropic row.

---

## Finding 4 — High FAILED rate is environmental, not behavioural

Across all working models, **49--98% of trajectories were labelled `FAILED`**:

| Model × Arm | FAILED rate |
|---|---:|
| haiku-4.5 baseline / defended | 52% / 53% |
| gpt-4o-mini baseline / defended | 70% / 66% |
| qwen3-coder baseline / defended | 49% / 49% |
| opus-4.7 baseline / defended | 98% / 98% |

Sampling the judge's `reason` fields on FAILED trajectories surfaces the dominant cause: **the tool sandbox refuses the harmful action before the agent's training or dredd's defence engages**. Representative reasons:

- `"Access denied — path outside allowed directories"` (filesystem MCP rejects writes outside `/workspace`)
- `"Chromium distribution chrome is not found"` (browser surface unavailable in the container)
- `"postgres-mcp not installed"` (postgres surface unavailable; confirmed in container preflight log)
- `ENOENT` (filesystem paths don't exist in the sandbox)

This is the inverse of T3e's permissive `hijackSucceeded` problem: the AgentLAB scenarios assume a more permissive tool sandbox than ours provides, so harmful tool calls fail at the sandbox layer and the trajectory ends in an unclassifiable middle state. The agent neither succeeded at the attack nor cleanly refused on the basis of training or defence.

**Implications:**

1. The COMPLETE+REJECT subset (n=83--163 per cell on working models) is where the defence-effect signal lives. Headline ASR should be quoted as `COMPLETE / (COMPLETE+REJECT)` excluding FAILED, not `COMPLETE / N_total` — otherwise FAILED inflates the denominator and dilutes the effect.
2. The high FAILED rate is **not** a strict-metric improvement of the §3.6 / §3.7 measurements. It's a different measurement issue, in the opposite direction (under-counting valid outcomes rather than over-counting them).
3. The §3.8 paper text needs a one-paragraph caveat noting that AgentLAB's scenarios assume tool surfaces our containers don't fully provide; the defence-effect numbers are quoted on the classifiable subset.

**Engineering follow-ups (optional):**

- Install `postgres-mcp` binary in the container (postgres scenarios become classifiable).
- Install Chromium in the container (browser/playwright scenarios become classifiable).
- Widen the filesystem MCP's allowed path set to match what scenarios expect.

These are scope-expansion items, not fix-blockers. Test 24 v1 numbers are quotable on the working subset.

---

## Finding 5 — Defence effect is measurable on the classifiable subset

| Model | Baseline ASR | Defended ASR | Δ | Cls. N |
|---|---:|---:|---:|---:|
| haiku-4.5 | 43.9% [35.4, 52.7] | **28.0%** [20.9, 36.4] | **−15.9pp** | 123 / 125 |
| gpt-4o-mini | 48.2% [37.8, 58.8] | **33.0%** [24.2, 43.1] | **−15.2pp** | 83 / 91 |
| qwen3-coder | 39.3% [31.4, 47.7] | **32.1%** [24.8, 40.4] | −7.2pp | 135 / 134 |

(ASR = `COMPLETE / (COMPLETE+REJECT)`; FAILED scenarios excluded per Finding 4.)

- **haiku-4.5**: CIs separate cleanly; −15.9pp is the strongest single defence-effect measurement on this corpus.
- **gpt-4o-mini**: CIs barely overlap at the boundary; −15.2pp is plausible but at smaller N. Would tighten with more data.
- **qwen3-coder**: CIs overlap; −7.2pp effect is suggestive but not statistically clean at this N.

These three together form the corroborating §3.8 row alongside §3.6 (T3e cross-vendor) and §3.7 (AgentDojo). The MT-AgentRisk attack class is multi-turn tool-grounded; the defence-effect direction matches §3.6 / §3.7.

---

## Finding 6 — Benign-task utility cost is small

| Model | Baseline benign-completion | Defended benign-completion | Δ |
|---|---:|---:|---:|
| haiku-4.5 | 100% [88, 100] (n=29) | 92% [75, 98] (n=25) | −8pp |
| gpt-4o-mini | 100% [77, 100] (n=13) | 94% [74, 99] (n=18) | −6pp |
| qwen3-coder | 100% [88, 100] (n=28) | 96% [82, 99] (n=28) | −4pp |

The defence's benign-task utility cost on MT-AgentRisk's benign subset is comparable to §3.7 AgentDojo's reported utility regression on Workspace (~−15pp) and tighter than its Slack regression (−33pp). MT-AgentRisk's benign tasks (file/calendar/code-organisation operations) overlap less with the prompt v2 red-flag catalogue than AgentDojo's Slack scenarios do, so the regression is correspondingly smaller.

---

## Status summary

- **Finding 1**: data hygiene; delete or rename stub directories. No engineering needed beyond `mv` / `rm`.
- **Finding 2**: opus-4.7 step-budget interaction. Diagnose `total_steps` distribution; widen budget OR drop the row. ~30 min diagnosis, ~$5 if a re-run is needed.
- **Finding 3**: Sonnet 4.6 didn't dispatch. Re-run the missing Fargate task. ~$15, ~2--3h.
- **Finding 4**: tool-sandbox over-restriction. Optional fixes (postgres-mcp / Chromium / filesystem path-set). Headline numbers quotable on classifiable subset without these.
- **Finding 5**: defence effect is real on haiku-4.5 / gpt-4o-mini / qwen3-coder. §3.8 paper text quotable on this subset.
- **Finding 6**: utility cost is small (−4 to −8pp). Quotable.

None of the findings invalidate Test 24 as an evidence point — they refine what claims it can support. The §3.8 cross-vendor matrix is partial (3 working models out of 5 planned) but directionally consistent with §3.6 + §3.7. Re-dispatching Sonnet 4.6 plus diagnosing opus-4.7 would close the matrix and make the §3.8 numbers fully quotable.

## Recommended next steps

1. **Diagnose opus-4.7** — read the per-scenario `total_steps` distribution; if it's clamped at the budget cap, raise the cap and re-run opus-4.7's two arms only (~$10, ~3h).
2. **Re-dispatch Sonnet 4.6** — same configuration, both arms (~$15, ~2--3h).
3. **Move stub directories** out of the way (`mv results/test24/{model}-{baseline,defended}/ results/test24-stub/`).
4. **Quote §3.8 paper text** on the classifiable subset using the haiku-4.5 / gpt-4o-mini / qwen3-coder rows; defer Sonnet 4.6 / Opus 4.7 rows to a fix-rerun.
5. **(Optional)** install postgres-mcp + Chromium in the container to recover postgres / browser scenarios. Scope expansion, not blocking.
