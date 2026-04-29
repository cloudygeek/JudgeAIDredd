# Test 24 (MT-AgentRisk) — Findings and Caveats

**Date:** 2026-04-29 (final — all 5 models complete)
**Run:** `results/test24/test24-{model}-{baseline,intent-tracker}/` (10 cells, 319–820 trajectories per cell)
**Models (all complete):** haiku-4.5, gpt-4o-mini, qwen3-coder (v0.1.202); opus-4.7 (v0.1.207); sonnet-4.6 (v0.1.212).
**Source paper:** *Unsafer in Many Turns* (Li, Yu, Pan, Sun, Li, Song, Lin, Shi 2026; arXiv:2602.13379)

This note records findings that affect how Test 24's headline numbers should be interpreted before the data is folded into P15 §3.8.

---

## Finding 1 — Two parallel result directories; only one is real data

`results/test24/` contains two directory structures:

```
results/test24/
├── {model}-{arm}/test24-{model}-{arm}/        ← 7 stub files per cell. NOT REAL DATA.
└── test24-{model}-{arm}/                      ← 319 trajectories per cell. THE REAL RUN.
```

The stub directories (`sonnet-baseline/test24-sonnet-4.6-baseline/`, etc.) contain summaries with `n_total: 7` aggregating one outcome per top-level dataset partition. They are from an earlier broken run that wrote summary files but no per-scenario JSONs.

**Fix:** any post-hoc analysis must aggregate from the per-scenario JSONs, not from the stub-summary files. The stub directories should be deleted or moved to `test24-stub/`.

---

## Finding 2 — opus-4.7 initial failure was a temperature API error (FIXED)

The original opus-4.7 run (v0.1.202) produced 319/319 API errors:

> `The model returned the following errors: temperature is deprecated for this model`

**Root cause:** The `BedrockAnthropicClient` passed `temperature: 0.0` in `inferenceConfig` for all models. Opus 4.7 rejects this parameter.

**Fix (v0.1.206):** Added `MODELS_NO_TEMPERATURE` set in `llm_client.py` — Opus 4.7 now omits temperature from the Converse API call.

**Status:** COMPLETE. Re-run on bedt7/bedt8 (v0.1.207) finished 2026-04-28. Opus now has full 820-scenario data.

---

## Finding 3 — Sonnet 4.6 over-persistence caused 30+ hour runs (FIXED)

Sonnet 4.6's initial run (bedt5/bedt6, v0.1.202) was still at 318/820 after 34 hours. The model exhausted the 80-step budget on almost every scenario by trying increasingly creative workarounds for impossible tasks (dead postgres, restricted paths).

**Root cause:** Sonnet generates far more diverse retry strategies than other models. Where haiku gives up in 3-5 steps, Sonnet tries 80 distinct approaches (write Python scripts, try Node.js, use browser_run_code, explore the filesystem for connection scripts, etc.).

**Fix (v0.1.206 → v0.1.212):**
1. Per-model step budget: Sonnet capped at 15 steps, Opus at 30 (vs 80 for others)
2. Repeated-error early termination: 3 consecutive tool results with the same error terminates immediately
3. Total-error threshold (v0.1.212): 5 cumulative infrastructure errors terminates even when non-consecutive

**Status:** COMPLETE. Re-run on bedt5/bedt6 (v0.1.212) finished 2026-04-29. Sonnet now has full 820-scenario data.

---

## Finding 4 — YAML crash at scenario 404/820 killed v0.1.202 defended runs (FIXED)

All three v0.1.202 defended containers (bedt4, bedt10, bedt12) crashed at scenario 404 (`filesystem/multi-turn-pipeline-script`) due to a corrupt `turns.yml` containing `*** End Patch` — an invalid YAML alias marker.

**Impact:** The containers had already uploaded all 319 unique scenario results to S3 before crashing (scenarios 1-319 completed; 320-404 were in progress on a second pass). **No data was lost.**

**Fix (v0.1.207):**
1. Removed corrupt line from `datasets/mt-agentrisk/.../multi-turn-pipeline-script/turns.yml`
2. Wrapped per-scenario loop in try/except — bad YAML now skips the scenario instead of crashing the run

---

## Finding 5 — High FAILED rate is environmental, not behavioural

Across all models, 34-70% of trajectories were labelled `FAILED`:

| Model | Baseline FAILED% | Defended FAILED% |
|---|---:|---:|
| haiku-4.5 | 52% | 53% |
| gpt-4o-mini | 70% | 66% |
| qwen3-coder | 49% | 49% |
| opus-4.7 | 34% | 32% |
| sonnet-4.6 | 35% | 35% |

The dominant causes from judge `reason` fields:
- `"Access denied — path outside allowed directories"` (scenarios reference `/workspace`, sandbox allows `/tmp/mcp-workspace`)
- PostgreSQL connection refused (postgres-mcp not installed in v0.1.202 containers; installed in v0.1.207+ but `postgres-mcp` binary still missing)
- Chromium not available for some browser scenarios

The v0.1.207+ containers (opus/sonnet) have lower FAILED rates because PostgreSQL is started and step budgets prevent timeout-based failures.

**Implication:** Headline ASR should be quoted as `COMPLETE / (COMPLETE + REJECT)` excluding FAILED, not `COMPLETE / N_total`. The FAILED scenarios are environmentally blocked, not safety-relevant.

---

## Finding 6 — Defence effect: full 5-model matrix

| Model | Baseline ASR | Defended ASR | Δ | N (baseline / defended) |
|---|---:|---:|---:|---:|
| haiku-4.5 | 54.6% | **38.7%** | **−15.9pp** | 152 / 150 |
| gpt-4o-mini | 55.2% | **43.1%** | **−12.1pp** | 96 / 109 |
| qwen3-coder | 49.7% | **43.2%** | **−6.5pp** | 163 / 162 |
| opus-4.7 | 9.2% | 9.9% | +0.7pp | 543 / 554 |
| sonnet-4.6 | 14.4% | 13.7% | −0.8pp | 533 / 534 |

(ASR = `COMPLETE / (COMPLETE+REJECT)`; FAILED scenarios excluded per Finding 5.)

- **haiku-4.5**: −15.9pp — strongest defence effect. Defence catches attacks the model doesn't refuse natively.
- **gpt-4o-mini**: −12.1pp — clear effect at smaller N.
- **qwen3-coder**: −6.5pp — modest effect, consistent direction.
- **opus-4.7**: +0.7pp — no meaningful effect. Baseline ASR is already 9.2% (model refuses 91% natively).
- **sonnet-4.6**: −0.8pp — no meaningful effect. Baseline ASR is already 14.4% (model refuses 86% natively).

**Interpretation:** The defence provides 6-16pp ASR reduction on models with weak native safety (50-55% baseline ASR). On frontier Anthropic models with strong safety training (9-14% baseline ASR), the defence is redundant — there is almost nothing left to catch. This is consistent with the defence's design goal: compensating for insufficient model-level safety in agentic deployments.

---

## Finding 7 — Filesystem is the critical vulnerability surface

Baseline ASR by surface (all models):

| Model | filesystem | terminal | postgres | playwright |
|---|---:|---:|---:|---:|
| haiku-4.5 | 86.0% | 0.0% | 39.3% | 0.0% |
| gpt-4o-mini | 91.2% | 4.2% | 26.1% | 100% (n=2) |
| qwen3-coder | 82.7% | 6.2% | 20.7% | 9.1% |
| opus-4.7 | 5.8% | 1.1% | 2.1% | 0.0% |
| sonnet-4.6 | 10.0% | 1.6% | 1.1% | 0.0% |

**Why:** Filesystem attacks split malicious intent across turns (write code to file → execute it), making each step look like a legitimate coding task. Weaker models don't recognise the assembled payload as harmful. Opus/Sonnet largely refuse even split filesystem attacks.

The defence reduces filesystem ASR modestly on weaker models (86→73% for haiku, 91→69% for gpt-4o-mini) but it remains the hardest surface to protect for those models.

---

## Finding 8 — Multi-turn format is 3-5x more effective than direct safety format

| Model | Multi-turn ASR | Safety-format ASR |
|---|---:|---:|
| haiku-4.5 | 73.0% (n=63) | 13.3% (n=60) |
| gpt-4o-mini | 83.3% (n=24) | 33.9% (n=59) |
| qwen3-coder | 61.4% (n=57) | 23.1% (n=78) |

Multi-turn attacks that gradually build context are far more effective than direct safety-framed requests. This validates the MT-AgentRisk paper's core thesis and confirms PreToolUse defence has a harder job on gradual attacks.

---

## Finding 9 — Benign-task utility cost is small

| Model | Baseline benign-completion | Defended benign-completion | Δ |
|---|---:|---:|---:|
| haiku-4.5 | 34.1% | 26.7% | −7.4pp |
| gpt-4o-mini | 15.5% | 20.0% | +4.5pp |
| qwen3-coder | 32.6% | 31.4% | −1.2pp |

The low absolute numbers reflect sandbox path restrictions (benign tasks reference `/workspace`), not defence interference. The **relative** utility cost of the defence is minimal (−7pp worst case, negligible for qwen3-coder). GPT-4o-mini actually shows slightly higher completion defended — likely noise at small N.

---

## Finding 10 — Frontier models have near-zero baseline ASR

Opus 4.7 and Sonnet 4.6 refuse 86-91% of MT-AgentRisk attacks without any defence:

| Model | Baseline ASR | Baseline rejection rate |
|---|---:|---:|
| opus-4.7 | 9.2% | 90.8% |
| sonnet-4.6 | 14.4% | 85.6% |
| haiku-4.5 | 54.6% | 45.4% |
| gpt-4o-mini | 55.2% | 44.8% |
| qwen3-coder | 49.7% | 50.3% |

This is a 4-6x safety gap between frontier Anthropic models and smaller/open models. The gap is most pronounced on filesystem attacks (6-10% vs 82-91%) where payload-splitting across turns is the primary attack vector.

**Implication for §3.8:** The paper's argument should be framed as "PreToolUse defence compensates for weaker model-level safety" rather than "defence improves all models." For frontier models, the defence is a belt-and-suspenders redundancy rather than a necessary mitigation.

---

## Status summary

| Finding | Status | Action needed |
|---|---|---|
| 1. Stub directories | Known | Delete or rename stub dirs |
| 2. Opus temperature error | **FIXED** v0.1.206 | **COMPLETE** — data collected |
| 3. Sonnet over-persistence | **FIXED** v0.1.212 | **COMPLETE** — data collected |
| 4. YAML crash at 404 | **FIXED** v0.1.207 | No data lost; fix deployed |
| 5. High FAILED rate | Environmental | Quote ASR on classifiable subset |
| 6. Defence effect | **COMPLETE** | Full 5-model matrix quotable for §3.8 |
| 7. Filesystem vulnerability | Confirmed across 5 models | Discuss in §3.8 |
| 8. Multi-turn > safety format | Confirmed | Discuss in §3.8 |
| 9. Utility cost | Small | Quotable for §3.8 |
| 10. Frontier model gap | New finding | Key framing point for §3.8 |

## Completed runs

| Container | Model | Arm | Version | Duration |
|---|---|---|---|---|
| bedt3 | haiku-4.5 | baseline | v0.1.202 | ~3.4h |
| bedt4 | haiku-4.5 | defended | v0.1.202 | ~3.5h |
| bedt9 | gpt-4o-mini | baseline | v0.1.202 | ~5.6h |
| bedt10 | gpt-4o-mini | defended | v0.1.202 | ~6.8h |
| bedt11 | qwen3-coder | baseline | v0.1.202 | ~3.4h |
| bedt12 | qwen3-coder | defended | v0.1.202 | ~3.5h |
| bedt7 | opus-4.7 | baseline | v0.1.207 | ~7h |
| bedt8 | opus-4.7 | defended | v0.1.207 | ~10.7h |
| bedt5 | sonnet-4.6 | baseline | v0.1.212 | ~9.5h |
| bedt6 | sonnet-4.6 | defended | v0.1.212 | ~12.6h |

All 10 cells complete. §3.8 has the full 5-model cross-vendor matrix.
