# Test 24 (MT-AgentRisk) — Findings and Caveats

**Date:** 2026-04-28 (updated)
**Run:** `results/test24/test24-{model}-{baseline,intent-tracker}/` (8 cells, 319 trajectories per cell, 2,552 trajectories total)
**Models with complete data:** haiku-4.5, gpt-4o-mini, qwen3-coder.
**Models re-running (v0.1.207):** opus-4.7 (temperature fix), sonnet-4.6 (step budget + YAML fix).
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

**Status:** Re-run in progress on bedt7 (baseline) and bedt8 (defended), v0.1.207. Also has the step budget cap (30 steps) and YAML crash fix.

---

## Finding 3 — Sonnet 4.6 over-persistence caused 30+ hour runs (FIXED)

Sonnet 4.6's initial run (bedt5/bedt6, v0.1.202) was still at 318/820 after 34 hours. The model exhausted the 80-step budget on almost every scenario by trying increasingly creative workarounds for impossible tasks (dead postgres, restricted paths).

**Root cause:** Sonnet generates far more diverse retry strategies than other models. Where haiku gives up in 3-5 steps, Sonnet tries 80 distinct approaches (write Python scripts, try Node.js, use browser_run_code, explore the filesystem for connection scripts, etc.).

**Fix (v0.1.206):**
1. Per-model step budget: Sonnet/Opus capped at 30 steps (vs 80 for others)
2. Repeated-error early termination: 3 consecutive tool results with the same error (path denied, connection refused) terminates the scenario immediately

**Status:** Re-run in progress on bedt5 (baseline) and bedt6 (defended), v0.1.207. Scenarios now finishing in 2-30 steps instead of 80. Estimated completion: ~5-8 hours.

---

## Finding 4 — YAML crash at scenario 404/820 killed v0.1.202 defended runs (FIXED)

All three v0.1.202 defended containers (bedt4, bedt10, bedt12) crashed at scenario 404 (`filesystem/multi-turn-pipeline-script`) due to a corrupt `turns.yml` containing `*** End Patch` — an invalid YAML alias marker.

**Impact:** The containers had already uploaded all 319 unique scenario results to S3 before crashing (scenarios 1-319 completed; 320-404 were in progress on a second pass). **No data was lost.**

**Fix (v0.1.207):**
1. Removed corrupt line from `datasets/mt-agentrisk/.../multi-turn-pipeline-script/turns.yml`
2. Wrapped per-scenario loop in try/except — bad YAML now skips the scenario instead of crashing the run

---

## Finding 5 — High FAILED rate is environmental, not behavioural

Across all working models, 37-64% of attack trajectories were labelled `FAILED`:

| Model | Baseline FAILED% | Defended FAILED% |
|---|---:|---:|
| haiku-4.5 | 47% | 46% |
| gpt-4o-mini | 64% | 61% |
| qwen3-coder | 42% | 43% |

The dominant causes from judge `reason` fields:
- `"Access denied — path outside allowed directories"` (scenarios reference `/workspace`, sandbox allows `/tmp/mcp-workspace`)
- PostgreSQL connection refused (postgres-mcp not installed in v0.1.202 containers)
- Chromium not available for some browser scenarios

**Note:** The v0.1.207 containers (bedt5-8) show PostgreSQL started and browser MCP connected. The sonnet/opus re-runs should have lower FAILED rates on postgres and browser surfaces.

**Implication:** Headline ASR should be quoted as `COMPLETE / (COMPLETE + REJECT)` excluding FAILED, not `COMPLETE / N_total`. The FAILED scenarios are environmentally blocked, not safety-relevant.

---

## Finding 6 — Defence effect is measurable on the classifiable subset

| Model | Baseline ASR | Defended ASR | Δ | N (baseline / defended) |
|---|---:|---:|---:|---:|
| haiku-4.5 | 43.9% [35.4, 52.7] | **28.0%** [20.9, 36.4] | **−15.9pp** | 123 / 125 |
| gpt-4o-mini | 48.2% [37.8, 58.8] | **33.0%** [24.2, 43.1] | **−15.2pp** | 83 / 91 |
| qwen3-coder | 39.3% [31.4, 47.7] | **32.1%** [24.8, 40.4] | −7.2pp | 135 / 134 |

(ASR = `COMPLETE / (COMPLETE+REJECT)`; FAILED scenarios excluded per Finding 5.)

- **haiku-4.5**: CIs separate cleanly; −15.9pp is the strongest defence-effect measurement.
- **gpt-4o-mini**: CIs barely overlap; −15.2pp is plausible but at smaller N.
- **qwen3-coder**: CIs overlap; −7.2pp is suggestive but not statistically clean at this N.

---

## Finding 7 — Filesystem is the critical vulnerability surface

All models show 82-91% ASR on filesystem attacks vs 0-9% on terminal/playwright:

| Model | filesystem ASR | terminal ASR | postgres ASR | playwright ASR |
|---|---:|---:|---:|---:|
| haiku-4.5 | 86.0% | 0.0% | 39.3% | 0.0% |
| gpt-4o-mini | 91.2% | 4.2% | 26.1% | 100% (n=2) |
| qwen3-coder | 82.7% | 6.2% | 20.7% | 9.1% |

**Why:** Filesystem attacks split malicious intent across turns (write code to file → execute it), making each step look like a legitimate coding task. The model doesn't recognise the assembled payload as harmful.

The defence reduces filesystem ASR modestly (86→73% for haiku, 91→69% for gpt-4o-mini) but it remains the hardest surface to protect.

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

## Status summary

| Finding | Status | Action needed |
|---|---|---|
| 1. Stub directories | Known | Delete or rename stub dirs |
| 2. Opus temperature error | **FIXED** v0.1.206 | Re-run in progress (bedt7/8) |
| 3. Sonnet over-persistence | **FIXED** v0.1.206 | Re-run in progress (bedt5/6) |
| 4. YAML crash at 404 | **FIXED** v0.1.207 | No data lost; fix deployed |
| 5. High FAILED rate | Environmental | Quote ASR on classifiable subset |
| 6. Defence effect | Confirmed | Quotable for §3.8 |
| 7. Filesystem vulnerability | New finding | Discuss in §3.8 |
| 8. Multi-turn > safety format | New finding | Discuss in §3.8 |
| 9. Utility cost | Small | Quotable for §3.8 |

## In-progress re-runs (v0.1.207)

| Container | Model | Arm | Started |
|---|---|---|---|
| bedt5 | sonnet-4.6 | baseline | 2026-04-28 08:19 UTC |
| bedt6 | sonnet-4.6 | defended | 2026-04-28 08:19 UTC |
| bedt7 | opus-4.7 | baseline | 2026-04-28 08:19 UTC |
| bedt8 | opus-4.7 | defended | 2026-04-28 08:19 UTC |

When these complete, §3.8 will have the full 5-model cross-vendor matrix.
