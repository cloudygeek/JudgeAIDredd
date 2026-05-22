# P14 — gaps remaining vs reviewer comments

Date: 2026-05-22
Source: `Adrian/p14/reviewer.txt` (Reviewer 1 + Reviewer 2 of the IEEE Access
submission, post-resubmission).

This document inventories what is **still missing** in the dredd worktree to
fully answer the reviewers. It does **not** restate what is already covered —
for the "what we already have" inventory and where each cross-vendor dataset
lives, see the analysis exchange that produced this file (in short: phaseB
InjecAgent x-vendor, phaseD AgentDojo all-four-suites, phaseE MT-AgentRisk
v426 cell-1, phaseE AgentLAB qwen3-235b sweep, test29 T3 variance on
gpt-4o-mini + qwen3-235b).

## Top-priority gaps (block acceptance of revised manuscript)

### G1. T1 / T3 / T4 / T8 × C1 / C3 / C4 cross-vendor matrix

**Reviewer 2:** "Replicating even a subset of configurations — T1, T3, T4, and
T8 across C1, C3, and C4 equivalents — on GPT-4o or a capable open-weight
model would substantially strengthen this claim."

**Status:** **Partial.** We have *per-benchmark* cross-vendor data
(InjecAgent / AgentDojo / MT-AgentRisk / AgentLAB) on GPT-4o-mini and
Qwen3-235B, but we do not have the paper's own T1/T3/T4/T8 × C1/C3/C4 cells
re-run on those vendors. The paper's primary matrix is constructed from the
internal p14 test harness (`results/test22/`, `results/test29/`), not from the
external benchmark suites.

**What is needed:**

- Re-run the p14 primary harness for techniques `{T1, T3, T4, T8}` across
  configurations `{C1, C3, C4}` against:
  - `gpt-4o-mini-2024-07-18` (OpenAI backend already wired in
    `bf4c0fd0 feat(test-framework): add OpenAI Chat Completions backend`)
  - `qwen.qwen3-235b-a22b-2507-v1:0` (Bedrock Converse, already used in
    phaseE-agentlab-qwen3-235b)
  - Ideally one additional GPT-4-class model (gpt-4o full, not -mini) so the
    "capable" qualifier in the reviewer's request is satisfied — gpt-4o-mini
    alone is borderline.
- C-configurations need a vendor mapping decision: C1 (CLI default) is
  Anthropic-specific (Claude Code). Define cross-vendor C1' equivalents:
  - C1': "vendor-default system prompt + sandbox + human-approval" (e.g.
    OpenAI Assistants API default safety message + container + approval gate)
  - C3': "raw API call, no system prompt, no approval"
  - C4': "raw API call, no guardrails, no sandbox"
  - The mapping rationale should be documented inline in the new results
    section so the comparison is interpretable.
- Single-run primary estimates per cell are sufficient for this matrix; the
  variance question is separate (G2).

**Acceptance test:** A Table 8'-equivalent with rows {T1, T3, T4, T8} ×
columns {C1, C3, C4, C1', C3', C4'} for at least two non-Anthropic models.

### G2. T4 variance dataset

**Reviewer 2:** "Please also extend the variance analysis to T4, which shows
one of the largest single-configuration drops in the primary results and is
currently unexamined."

**Status:** **Gap.** The skeleton files in
`results/test22/p14-T4-claude-sonnet-4-6-{C1,C4}-{baseline,judge}-T4.{1,2,3}-…json`
are all `reps: 0`, `n: 0` — they are placeholder runs that never executed.

**What is needed:**

- 90 repetitions per cell (matching V1/V2 sample size for T3) at:
  - T4 / C1 / Sonnet / standard reasoning
  - T4 / C4 / Sonnet / standard reasoning
  - and ideally one more cell at C3 (no system prompt) to bracket the
    factorial decomposition
- Same harness invocation pattern as test29 (`test29-converse-…`,
  `repetitions: 90`).
- Compute Hartigan dip test + Gaussian mixture BIC on the resulting GES
  distribution (script does not yet exist — see G5).

**Acceptance test:** Bimodality verdict (reject / fail to reject unimodality)
for T4 at C1 and C4, reported with the same statistics as Sonnet T3 in
Finding 1.

### G3. Per-model variance for Haiku and Opus on T3

**Reviewer 2:** "Per-model variance analysis for Haiku and Opus on T3 would
allow you to either substantiate or appropriately qualify Finding 3 on the
capability-compliance trade-off."

**Status:** **Partial.**

- **Sonnet T3 variance:** present (`results/test29/` and earlier; n=90,
  bimodal, already in paper Finding 1).
- **Opus T3 variance:** thin. `results/test18-opus-pilot/t3e-…` and
  `results/test18-bedt4/t3e-…` have n=20 per scenario, both `none` and
  `intent-tracker` defences, for T3e.2 / T3e.3 / T3e.4. n=20 is too small for
  a bimodality test at the V1/V2 fidelity. (The paper's L5 limitation
  acknowledges Sonnet-only variance; closing that needs ≥45 reps, preferably
  90.)
- **Haiku T3 variance:** **absent.** No `*haiku*T3*` or `*haiku-4-5*T3*`
  files exist in `results/`.

**What is needed:**

- 45–90 reps of T3.2 (or T3.4, since that is where the gpt-4o-mini bimodality
  is sharpest) at C1 for:
  - Haiku-4.5 (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`)
  - Opus-4.7 (`eu.anthropic.claude-opus-4-7`) — extend the existing n=20 to
    n=90, do not start over.
- Report per-model Hartigan dip-test result alongside the existing Sonnet
  numbers. Finding 3 then either upgrades from "single-run point estimate" to
  "supported by variance" or is explicitly qualified as
  "capability-compliance ordering not preserved under variance" if the
  per-model means change.

**Acceptance test:** Table replacement for paper text at `p14_b.tex:1190`
("Note that these per-model T3 figures are point estimates…") with three
rows (Haiku, Sonnet, Opus) reporting mean GES, 95% CI, dip-test D and p.

### G4. MT-AgentRisk v426 defence cells 2–4

**Status:** **Pending — running externally.** Per commit `6430a651`, only
cell-1 (defence=none) of the v426 full-820 sweep is synced. Cells 2–4
(intent-tracker / promptarmor / it+pa) are still iterating on bedt3/4/5 and
will need to be pulled from S3 once complete.

**What is needed:**

- Sync the remaining cell directories under
  `benchmarks/mt-agentrisk/runs/phaseE-mt-agentrisk-full-{haiku45,gpt4omini}-v426-20260522T075219Z/`
  once bedt3/4/5 finish.
- Produce the four-cell ASR table per vendor (none / intent-tracker /
  promptarmor / it+pa) so the defence-layer decomposition can be re-stated
  cross-vendor.
- Re-validate that the pre-v426 haiku45 sweep
  (`phaseE-mt-agentrisk-haiku45-20260521T212743Z`) stays out of any results
  table — its empty-MCP image makes the flat ASR cells uninformative
  (already flagged in commit message).

**Acceptance test:** A 2-model × 4-defence MT-AgentRisk table that mirrors
the InjecAgent x-vendor matrix.

## Medium-priority gaps

### G5. Bimodality computation script

**Status:** **Gap.** `docs/test_plan.md` references
`analysis/compute-bimodality.py` (Hartigan dip + Ashman's D) but the file does
not exist in the repo. The paper's Finding 1 numbers (D=0.172, p<10⁻³,
ΔBIC≈1797) were computed offline and pasted into the manuscript; the
computation is not reproducible from the repo.

**What is needed:**

- A script `scripts/compute-bimodality.py` taking a list of run JSONs (test29
  shape) and emitting: n, mean, sd, BC (SAS-style), dip statistic, dip
  p-value (via `diptest` package), 2-component GMM BIC, single-component
  GMM BIC, mixture weights, mixture means.
- Used to regenerate the paper's Finding 1 numbers reproducibly, and to
  compute G2 (T4) and G3 (per-model T3) bimodality verdicts.

**Acceptance test:** Re-running the script over the existing Sonnet V1 / V2
variance datasets reproduces the manuscript's D, p, ΔBIC, mixture weights
within rounding.

### G6. GES decomposition table in dredd (per-cell P_r, E_r, S_r)

**Reviewer 2:** "Please report prevention rate, exfiltration rate, and
stealth rate independently in Table 8 alongside the composite score."

**Status:** The paper text at `p14_b.tex:1194` already states this has been
done in supplementary Appendix A (Table S1). The underlying per-cell
P_r/E_r/S_r counts need to be computable from the run JSONs in this
worktree — they currently aren't surfaced anywhere queryable. The supplementary
table was assembled by hand or in a separate script not committed here.

**What is needed:**

- Add a small aggregator `scripts/ges-decomp.py` that walks the primary
  matrix (test22/test29-equivalent JSONs) and emits a CSV of
  (technique, configuration, model, n, P_r, E_r, S_r, GES, GES_sw) so the
  supplementary Table S1 can be regenerated from raw runs rather than
  hand-typed.
- Use the same artefact to produce the cross-vendor decompositions for G1.

### G7. AgentDojo cross-vendor data provenance fix

**Status:** **Documented but not re-run.** The qwen3-235B summary JSONs in
`benchmarks/agentdojo/runs/phaseD-20260514/qwen3-235b-all4suites/` carry a
`_note` that says they were reconstructed from per-cell log tails because
image v0.1.347 clobbered the per-defence JSONs to a single (last) suite.
Numbers are believed correct (the `.travel-only.json` files preserve the
clobbered state for provenance) but per-suite provenance is reconstructed.

**What is needed:**

- Re-run the affected cells on a post-`1ed46b63` image (v0.1.348+) so the
  per-defence summary JSONs are native rather than reconstructed.
- Alternatively, document the reconstruction in the manuscript's
  supplementary material with a pointer to the `.travel-only.json` artefacts.

## Low-priority gaps (will not block acceptance but were asked for)

### G8. Computational overhead / utility-vs-security trade-off table

**Reviewer 1:** "Including more discussion on computational overhead and
usability trade offs introduced by different guardrail layers would improve
deployment relevance."

**Status:** The data is **present** but not assembled into a table. AgentDojo
qwen3-235B shows the utility cost of Dredd B7.1 starkly (workspace utility
29.8% → 2.7%; slack 63.8% → 0.0%) versus PromptArmor (29.8% → 58.2%;
63.8% → 63.8%). InjecAgent and AgentLAB also have utility implications.

**What is needed:**

- One table in the resubmission showing, for each defence layer
  (none / system-prompt / sandbox / approval / Dredd / PromptArmor / it+pa):
  attack success rate, utility on benign tasks, per-call latency overhead,
  per-call token overhead.
- Latency / token overhead numbers must come from the actual run logs — the
  per-cell `*.log` files in
  `results/2026-05-20-phaseE-opus47-and-cross-vendor/` and
  `benchmarks/*/runs/` carry duration totals (the `OK 8104` etc. column in
  the summary.log files).

### G9. False-positive / negative analysis

**Reviewer 1:** "Including more analysis on false positives, false
negatives, and potential guardrail bypass scenarios would improve the
robustness discussion."

**Status:** **Partial — needs framing rather than new data.**

- PromptArmor FP signal: in InjecAgent DH on Sonnet under PromptArmor,
  `screened_injected = 499 / 510` even though the bare-agent `none` cell sees
  zero successful injections — PromptArmor is screening positively on
  near-100% of attempts where no actual injection harm would occur on the
  Anthropic models. This is a directly quotable FP-rate datapoint.
- Dredd B7.1 on qwen3-235B InjecAgent DS blocked 227 of ~544; bare-agent
  baseline saw 239 successful injections — so Dredd's block rate is well
  matched to true-positive rate on the vulnerable vendor. Need to compute
  per-cell precision/recall properly.

**What is needed:**

- A short FP/FN section that cites the screening-vs-baseline counts above
  and computes precision/recall per defence × model.
- No new runs required.

### G10. Long-term maintainability discussion (Reviewer 1.4)

**Status:** **Gap, prose-only.** Paper text at `p14_b.tex:1243` mentions
prompt drift on model updates and proposes a canary subset of T3/T4/T8 on
C1/C4 re-run per vendor release. This is currently a single paragraph in the
manuscript — Reviewer 1 wants more.

**What is needed:**

- Expand the maintenance paragraph in the manuscript (no new data) to
  cover: (i) canary subset definition, (ii) re-validation cadence, (iii)
  cost projection for the canary subset, (iv) drift-detection threshold
  (e.g. ±10 GES points triggers full re-run), (v) operator runbook for
  acting on a flagged regression.
- This is a writing task, not a dredd task. Listed here for completeness.

### G11. Vendor-blog citation hygiene (Reviewer 2 + R1 implicit)

**Status:** **Out of scope for dredd.** Refs 3 (84% / 32% figures) and 35
(false-positive / false-negative claims for Auto Mode) need either
independent corroboration or explicit "vendor-reported, unverified" flagging.
No empirical data in this worktree replaces those numbers; this is a
manuscript-only fix.

## Summary table

| ID | Topic | Reviewer | Status | Effort |
|----|-------|----------|--------|--------|
| G1 | T1/T3/T4/T8 × C1/C3/C4 cross-vendor matrix | R2.1 | Partial | Large (≥4 days harness time) |
| G2 | T4 variance dataset (90 reps × ≥2 configs) | R2.2 | Gap | Medium (~1 day) |
| G3 | Haiku/Opus T3 variance | R2.3 | Partial | Medium (~1 day) |
| G4 | MT-AgentRisk v426 cells 2–4 sync | own | Pending external | Small (just S3 sync once jobs finish) |
| G5 | Bimodality computation script | own | Gap | Small (~half-day) |
| G6 | GES decomposition aggregator | R2 | Gap | Small (~half-day) |
| G7 | AgentDojo qwen3 re-run on fixed image | own | Optional | Medium |
| G8 | Overhead / utility trade-off table | R1.3 | Data present, table missing | Small |
| G9 | FP/FN analysis | R1.5 | Data present, analysis missing | Small |
| G10 | Maintainability prose expansion | R1.4 | Manuscript-only | Small |
| G11 | Vendor-blog citations | R2 | Manuscript-only | Small |

## Notes on the underlying data

- **T3 cross-vendor bimodality is real.** gpt-4o-mini T3.4 under defence=none
  gives BC=0.756 (>0.555 threshold) with the sorted GES distribution
  `[0, 33.3×24, 100×20]`. This is independent corroboration of Finding 1 on
  a non-Anthropic model and should be added to the paper irrespective of G3.
  Source:
  `results/test29/29a/29a-T3.3-T3.4/test29-openai-gpt-4o-mini-none-T3.4-2026-05-01T15-20-08-137Z.json`.
- **MT-AgentRisk v426 disambiguation:** two `summary-*-full.json` files
  exist per cell-1 directory; the `075733-full.json` one is canonical
  (matches the cell's RUN_ID); `07{1107,2243}` are smoke leftovers from the
  earlier RUN_ID. See `feedback_mt_agentrisk_summary_disambiguation` for
  the rule going forward.
- **Pre-v426 haiku45 MT-AgentRisk** must be excluded from any analysis —
  empty MCP, ASR is bare-floor across all four defence cells.
