# Tests Needed to Close P15 Springer Revision Data — 2026-05-13

**Author of this gap-analysis:** Claude Opus 4.7 (1M)
**Context:** Springer Cybersecurity revision per `Adrian/p15/PLAN_springer_revision.md` (decisions locked 2026-05-08). Stage B of the plan ("PromptArmor head-to-head + InjecAgent corpus") is partially complete; this document maps what is still outstanding before the paper is submission-ready.

**Method.** Mapped every empirical claim in `Adrian/p15/p15.tex` (commit `b0bd6ce`, IEEE Access conversion) against `benchmarks/{injecagent,agentdojo,mt_agentrisk}/runs/**/summary.json` and the older `results/agentdojo-*` directories. Cross-referenced against `docs/phase-b-results-2026-05-11.md` and `docs/phase-c-results-2026-05-12.md`. Where data already exists in the published Springer/IEEE-Access paper for AIDredd vs none, the gap is what the plan *added* — PromptArmor as a comparator.

---

## TL;DR

**13 cells still needed.** Three are high-priority (T3e × PromptArmor across vendors; MT-AgentRisk × PromptArmor; AgentDojo other suites × PromptArmor). Total estimated wall ~26 hours and ~$60–95 API spend across Bedrock + OpenAI.

Everything AIDredd-side that the paper already cites is on disk. The gap is PromptArmor coverage on three of the four pre-existing corpora and one missing InjecAgent cell.

---

## Inventory: what exists

### InjecAgent (n=1054, base setting only)

| Model | none | B7.1 | promptarmor | Source |
|---|---:|---:|---:|---|
| opus-4-7 | 0.0% | 0.0% | (saturated; cancelled per phase-c-results) | phaseC c1-opus47-retry2(+cell2-B7.1) |
| sonnet-4-6 | 0.0% | **MISSING** | 0.0% | phaseB-20260509/sonnet-opus47 |
| gpt-4o-mini | 16.7% | 0.2% | 0.3% | phaseC c6-gpt4omini-{baseline,retry3} |
| qwen3-32b | 24.5% | 0.1% | 1.2% | phaseB-20260510/qwen3-32b |
| qwen3-235b | 33.7% | 0.1% | 3.1% | phaseC qwen3-235b-headtohead |

**Coverage: 14/15 cells. Missing: sonnet × B7.1.**

### AgentDojo `important_instructions` × `workspace` (n=560 per cell)

| Model | none | B7.1 | promptarmor | Source |
|---|---:|---:|---:|---|
| opus-4-7 | 0.0% | 0.0% | 0.0% | phaseB-20260510/opus47 |
| sonnet-4-6 | 0.0% | 0.0% | 0.0% | phaseB-20260510/sonnet |
| gpt-4o-mini | 17.0% | 0.0% | 9.3% | phaseC gpt4omini-headtohead |
| qwen3-32b | 8.9% | 0.2% | 4.5% | phaseC qwen3-32b-headtohead |
| qwen3-235b | — | — | — | **MISSING entire model** |

**Note: paper's `tab:agentdojo-cross-vendor` reports the full 4 suites × `important_instructions` (n=949 weighted) for AIDredd vs none across six rows.** That data lives elsewhere (older `results/agentdojo-*` from April). What the plan added is **PromptArmor** on the same matrix. We have PromptArmor for workspace only.

### MT-AgentRisk

- Paper §sec:mt-agentrisk reports 5 Bedrock rows × 2 arms (AIDredd, none).
- `benchmarks/mt_agentrisk/runs/` does **not exist** — code only.
- **No PromptArmor run yet.**

### T3e (paper's own corpus)

- Paper §sec:t3-pretooluse reports T3e.2–T3e.4 across 5 backends (Sonnet 4.6, Opus 4.7, Qwen3-32B/235B/Coder-30B) with N=600 baseline + N=20 defended per scenario.
- AIDredd data on disk via Test 29 / earlier tests.
- **No PromptArmor on T3e.** Plan Stage B explicitly listed it (~600 invocations × 5 backends).
- Explicitly deferred per `docs/phase-c-results-2026-05-12.md`: *"C5 (T3e × Qwen3-32B + Qwen3-235B) — paper's own corpus head-to-head, deferred."*

### AgentLAB

- Paper §sec:agentlab-smoke reports 7 Bedrock-hosted defended agents × 2 arms at smoke scale N=10.
- **No PromptArmor on AgentLAB.** Plan Stage B listed ~1,200 invocations × 5 backends.

---

## Gaps mapped to plan-Stage-B scope

The plan said: 5 corpora × 5 backends × {none, AIDredd, PromptArmor} ≈ 75 cells. Five-backend list: GPT-4o, GPT-4.1, o4-mini, Sonnet 4.6, Opus 4.7. **Actual backend slate diverges** — we substituted gpt-4o-mini, qwen3-32b, qwen3-235b for GPT-4o/4.1/o4-mini. This produces a *broader* cross-vendor sweep than the plan (Anthropic + OpenAI-mini + 2× Alibaba) at the cost of not matching PromptArmor's reported backends. Acceptable for the paper's *own* cross-vendor claim; insufficient for replicating PromptArmor's <1% FPR/FNR claim on its native backends. **Decision needed** (see §"Open decisions" below).

---

## Tests still to run, ranked

### P0 — strictly required to close the plan's promises

#### T-1. InjecAgent: sonnet-4-6 × B7.1 × base
- **What:** the only missing InjecAgent cell.
- **Why:** completes the 5×3 matrix; lets the paper claim full PromptArmor head-to-head on InjecAgent.
- **Expected outcome:** ~0% ASR (sonnet × none is already 0.0%; AIDredd cannot make it worse).
- **Cost/time:** Bedrock Sonnet 4.6, ~1054 cases, ~2 h wall, ~$2–5 spend.
- **Command sketch:**
  ```bash
  python benchmarks/injecagent/run_benchmark.py \
      --model sonnet --model_id eu.anthropic.claude-sonnet-4-6 \
      --defence B7.1 --dredd_mode autonomous --setting base \
      --output_dir benchmarks/injecagent/runs/phaseC-20260513/sonnet-B7.1
  ```

#### T-2. T3e × PromptArmor across vendors
- **What:** wire `promptarmor_defense.py` into the T3e runner (paper's own corpus, `Adrian/p15/test-framework/`), then run T3e.2–T3e.4 across:
  - Sonnet 4.6, Opus 4.7, Qwen3-32B, Qwen3-235B, GPT-4o-mini (5 backends), arm = PromptArmor, N=60 per scenario per cell (= ~900 invocations × 5 backends ≈ 4,500 calls).
- **Why:** the plan promised T3e × PromptArmor; without it, the paper cannot claim PromptArmor was tested on the paper's own corpus, which is the most defensible head-to-head ground.
- **Expected outcome:** PromptArmor at near-zero on Anthropic-floor agents, measurable on Qwen rows; the comparator to AIDredd's reported `exfiltrationDetected = 0/360` defended cell.
- **Cost/time:** ~6 h wall, ~$25–35 spend (Sonnet preprocessor calls dominate; ~1500ms × 4500 ≈ 6h serial, parallelise across backends).
- **Blocker:** **PromptArmor screening is not yet wired into the T3e test-framework**. `test-framework/src/` has no `promptarmor-baseline.ts`. Plan B1 anticipated this as ~1 day of implementation work. **Build that first, then run.**

#### T-3. MT-AgentRisk × PromptArmor (and verify AIDredd run reproducibility)
- **What:** run MT-AgentRisk benchmarks with PromptArmor preprocessor across the same 5 defended-agent rows the paper reports for AIDredd vs none.
- **Why:** plan promised it; reviewers will ask for the third-corpus PromptArmor comparison after seeing it on InjecAgent and AgentDojo.
- **Caveat:** `benchmarks/mt_agentrisk/runs/` is empty. The paper's existing §sec:mt-agentrisk numbers must come from an earlier results-tree location (`results/test28/` cross-judge sample is the most recent visible MT-AgentRisk artefact; the full per-cell data may be elsewhere). **Before running PromptArmor, find and document where the AIDredd MT-AgentRisk runs are stored**, or rerun them so the comparator and baseline share infrastructure.
- **Cost/time:** ~6 h wall, ~$15–25 spend, assuming ~300 trajectories × 5 backends with PromptArmor preprocessor at ~1.5 s/call.

#### T-4. AgentDojo other suites × PromptArmor (banking / slack / travel)
- **What:** extend the gpt-4o-mini and qwen3-32b PromptArmor cells from the workspace-only slice to the other three suites; add the missing qwen3-235b model across all four suites.
- **Why:** paper's `tab:agentdojo-cross-vendor` reports `important_instructions` weighted across all 4 suites (n=949 weighted) for AIDredd vs none. PromptArmor coverage is currently only workspace (n=560). The Opus 4.7 Travel-suite residual (13.6% baseline / 14.3% defended) is the paper's one non-floor Anthropic cell — PromptArmor's behaviour on that exact suite is therefore the most interesting cell to add.
- **Expected outcome:** sharper comparator on the Travel suite specifically; confirms or disputes PromptArmor's <1% FPR/FNR on full AgentDojo.
- **Cost/time:** ~8 h wall, ~$15–25 spend. 4 models × 3 missing suites = 12 cells × ~560 tests ≈ ~6700 PromptArmor calls.
- **Sub-decision:** also add `tool_knowledge` attack type? Currently only `important_instructions` is in the paper. PromptArmor's reported numbers are weighted across attack types. If reviewers ask, this is +4× cost. **Recommend deferring `tool_knowledge` until reviewers ask.**

### P1 — strongly recommended, not strictly required

#### T-5. Composite arm: PromptArmor ∥ AIDredd on gpt-4o-mini × InjecAgent
- **What:** one extra cell where both defences run in series; tests whether their failure modes compose to ASR ≈ 0.
- **Why:** based on the 6 case studies analysed today, the failure modes are orthogonal:
  - 3 AIDredd let-throughs (judge classifies as `drifting`, not `hijacked`)
  - 3 PromptArmor let-throughs (verdict `injected` but `sanitisation_failed: true`)
  - Zero overlap on the 6 cases examined.
  This is the defence-in-depth argument; a single composite cell would let the paper claim it instead of speculating.
- **Cost/time:** ~2 h wall, ~$5–7 spend (1054 cases × both preprocessors).
- **Predicted ASR:** ≤ 0.1% if the orthogonality story holds.

#### T-6. Drift-threshold sensitivity sweep
- **What:** on a 100-case subsample of InjecAgent ds attacks, sweep drift-deny threshold ∈ {0.10, 0.12, 0.15 (current), 0.18, 0.20}.
- **Why:** the current `0.135 < 0.15` deny on case `ds #406` is on a 0.015-margin. A small ablation would convert the single-point ASR estimate into a sensitivity curve.
- **Cost/time:** ~1 h wall, ~$2 spend (re-evaluation of cached trajectories at different thresholds is mostly compute-free; only re-run if thresholds change downstream behaviour).

#### T-7. InjecAgent: re-run ds #384 with a non-empty Spokeo mock
- **What:** one-case targeted re-run.
- **Why:** the case currently shows AIDredd `eval=succ` on step 1 (judge-allow with `drifting` verdict) but `eval Step 2=unsucc` *because the Spokeo mock returned empty*. With a populated mock, S2 would either succeed (proving AIDredd's S2 protection is incomplete) or be caught by S2's drift gate (proving the second-stage defence). Either result is publishable; the current data leaves the question open.
- **Cost/time:** negligible (~5 min).

### P2 — useful but skippable

#### T-8. AgentLAB × PromptArmor at smoke scale
- **What:** 5 backends × {PromptArmor} at N=10 per cell (= 50 trajectories per cell, ≈ 50 PromptArmor calls per cell).
- **Why:** completeness — closes the fourth-corpus PromptArmor comparison.
- **Skip-rationale:** AgentLAB is already smoke-scale in the paper; adding PromptArmor smoke-scale on top is marginal evidence and reviewers are more likely to ask for full-scale AgentLAB before they ask for PromptArmor at smoke-scale.
- **Cost/time:** ~2 h wall, ~$3–5 spend if pursued.

#### T-9. InjecAgent `enhanced` setting
- **What:** rerun the InjecAgent matrix with `setting=enhanced` (attacker-controlled hint added to user prompt).
- **Why:** reviewers may ask. Plan didn't promise it.
- **Skip-rationale:** can be addressed in §limitations as "out of scope for this revision; base setting follows InjecAgent's primary protocol".

#### T-10. Disagreement analysis (Plan B5)
- **What:** pull 30–50 cases where PromptArmor and AIDredd disagree across all corpora; classify the disagreement type.
- **Why:** Plan B5 promised this as a qualitative §7 table.
- **Status:** 6 cases analysed today across one corpus (gpt-4o-mini × InjecAgent). Need ~30 more across other corpora.
- **Cost/time:** ~½ day analysis only; no new runs needed (uses existing data once T-2/T-3/T-4 are done).

---

## Methodological finding (not a bug to fix)

### B-1. PromptArmor `sanitisation_failed: true` is fuzzyStrip's expected fallback
**Initial framing was wrong.** The original phrasing in this doc said the
sanitisation step "crashes" and called it a bug. After tracing
`src/promptarmor-baseline.ts` the actual mechanism is a token-walk
limitation in the paper's own §3.1 fuzzy-strip, not a runtime failure:

1. PromptArmor detector returns `Yes / Injection: <quoted-span>`.
2. `fuzzyStrip` walks `content` left-to-right looking for each
   whitespace-separated token of `<quoted-span>` in order.
3. If any token fails to match (LLM paraphrased the injection,
   inserted/dropped a word, or hallucinated a span the source doesn't
   contain), the strip returns `matched=false`.
4. The harness sets `sanitised = content` (unmodified) and ships
   `verdict: injected, sanitisation_failed: true` to the caller. The
   verdict log says "we caught it!" but the *content* the model sees
   is unchanged.

**Cases:** `dh #171` (Evernote→EmergencyDispatch), `ds #406`
(Twitter→TDAmeritrade+Email), `ds #407`
(WebBrowser→TDAmeritrade+Email). All three have detector quotes that
diverge from the source content enough to defeat token-order matching.

**Implication for paper:**
- This is a **legitimate finding to report**, not a bug in our
  reproduction. We're following PromptArmor's per-paper §3.1 strip
  algorithm exactly. The 3/1054 = 0.28% leakage rate is what their
  published methodology produces on adversarial paraphrase.
- The §7 disagreement table can use this as one of the
  defence-in-depth bullets: PromptArmor's strip is brittle on
  paraphrased detector outputs; AIDredd's deny-the-whole-call
  semantics doesn't have this failure mode.
- **No re-runs of T-2/T-3/T-4 needed** to address B-1. The current
  numbers are an honest reproduction.

**Optional follow-up** (not on the critical path): add a
`sanitisation_failed → strip whole block` fallback to our
`promptarmor-baseline.ts` if reviewers ask for a "PromptArmor under
adversarial paraphrase" comparator. Estimated 1h of work; would
likely drive PromptArmor's gpt-4o-mini ASR from 0.3% → 0.0% on
InjecAgent and could be reported as "PromptArmor + AIDredd-style
fail-closed semantics" — but this is *not* PromptArmor as published.

---

## Open decisions before running

### D-1. Backend slate: substitute or add OpenAI models?
Plan named GPT-4o, GPT-4.1, o4-mini, Sonnet 4.6, Opus 4.7. We ran gpt-4o-mini + Sonnet 4.6 + Opus 4.7 + Qwen3-32B + Qwen3-235B. Two options:
- **(a)** Treat current slate as final; defend the substitution in §3.4 of the paper as "broader cross-vendor coverage at the cost of OpenAI-tier breadth". Cheaper.
- **(b)** Add GPT-4o (full, not mini) to InjecAgent + AgentDojo cells for at least one corpus to enable a direct PromptArmor-paper-replication claim. ~+$15–25 and ~+3 h.

**Recommend (a) unless reviewers specifically signal OpenAI-tier-breadth as a gap; budget allows (b) as a follow-up if needed.**

### D-2. T3e PromptArmor implementation work
Plan B1 said ~1 day to build `promptarmor-baseline.ts` in `test-framework/src/`. **Has this been built?** The InjecAgent and AgentDojo PromptArmor cells exist (via `benchmarks/*/promptarmor_defense.py`), but the *T3e* runner is in a different codebase (`Adrian/p15/test-framework/`, TypeScript) and may not have a PromptArmor adapter yet. **Verify before estimating T-2 effort.** If not built, add ~1 day to T-2.

### D-3. Cap order if budget exceeded
Plan §4 says: drop AgentLAB first, then InjecAgent, if budget hits. With InjecAgent largely done, the new prioritisation should be: drop **T-8 (AgentLAB × PromptArmor) first**, then **T-9 (InjecAgent enhanced)**, then **T-6 (threshold sweep)**, then **T-5 (composite arm)**. **T-1 to T-4 are not droppable** — without them the plan-promised PromptArmor head-to-head is incomplete.

---

## Total budget if all P0+P1 run

| Item | Time | Spend |
|---|---:|---:|
| T-1 InjecAgent sonnet × B7.1 | 2 h | $5 |
| T-2 T3e × PromptArmor (incl. 1 day build if needed) | 6–14 h | $35 |
| T-3 MT-AgentRisk × PromptArmor (+ baseline-data audit) | 6 h | $25 |
| T-4 AgentDojo other suites × PromptArmor | 8 h | $25 |
| T-5 Composite arm (one cell) | 2 h | $7 |
| T-6 Threshold sensitivity sweep | 1 h | $2 |
| T-7 ds #384 re-run | <1 h | <$1 |
| **P0+P1 total** | **25–33 h** | **~$100** |
| (P2 if added: T-8) | +2 h | +$5 |

Under the plan's $250 cap; ~12% of remaining budget.

---

## Suggested execution order

1. **T-1** (InjecAgent sonnet × B7.1) — quickest closure, no infrastructure work needed.
2. **B-1 investigation** (PromptArmor sanitisation bug) — affects how T-2/T-3/T-4 results should be reported; do this *before* the new PromptArmor runs so any fix is in the data.
3. **D-2 check** (does T3e PromptArmor adapter exist?) — gates T-2 estimate.
4. **T-7** (ds #384 re-run) — trivial, removes one near-miss from the data.
5. **T-3** (MT-AgentRisk) — clarifies where existing AIDredd baseline data lives; necessary regardless.
6. **T-2** (T3e × PromptArmor) — paper's own corpus is the highest-value comparison.
7. **T-4** (AgentDojo other suites) — extends existing infrastructure.
8. **T-5** (composite arm) — last-mile defence-in-depth story.
9. **T-6** (threshold sweep) — analysis, mostly cached.
10. **T-10** (disagreement analysis writeup) — purely textual after all data is in.

---

## What's *not* needed (explicit non-list)

To avoid scope creep:

- **No new AIDredd runs on already-published cells.** T3e, AgentDojo `important_instructions`, MT-AgentRisk, AgentLAB all have AIDredd vs none data the paper already cites.
- **No re-run of opus-4-7 × PromptArmor on saturated cells.** phase-c-results documented the cancellation as correct (zero defence delta on a 0% baseline = no information).
- **No additional reasoning-effort sweep.** The paper's adversarial calibration is closed in §sec:adversarial.
- **No new judge-leaderboard table.** Section already final.
- **No re-grading of cross-judge sensitivity sample.** §sec:limitations's balanced 50-trajectory dual-grade is sufficient per pass-6 peer review.

---

## Provenance

- Paper draft: `Adrian/p15/p15.tex` @ commit `b0bd6ce` (IEEE Access conversion). Springer revision plan: `Adrian/p15/PLAN_springer_revision.md` decisions locked 2026-05-08.
- Existing benchmark data inventoried from `benchmarks/{injecagent,agentdojo,mt_agentrisk}/runs/**/summary.json` and `results/agentdojo-*` directories.
- Latest peer review: `Adrian/p15/PEER_REVIEW_2026-05-02-pass7.md` (recommends minor revisions; does *not* itself request new data, but the plan-locked Springer revision does).
- Phase B/C runbooks: `docs/phase-b-results-2026-05-11.md`, `docs/phase-c-results-2026-05-12.md`.

This document is the input to a "phase D" planning conversation. It does not commit to any of the listed runs; it just enumerates what's needed to make the plan's promises fully match what's on disk.

---

## Edits / caveats (2026-05-13, post-review)

Caveats applied after a second pass on the doc. Substantive corrections
the original analysis missed:

1. **T-1 framing fix.** The doc says *"sonnet × none is already 0.0%; AIDredd
   cannot make it worse"*. The missing cell is sonnet × **B7.1** (a defended
   cell, AIDredd-on), not a baseline comparator. Expected ~0% is right; the
   reasoning sentence is muddled. Treat T-1 as confirming AIDredd ≤ none (the
   "no regression" sanity check), not as a "can't make it worse" tautology.

2. **D-2 (T3e PromptArmor adapter) is a hard blocker for T-2.** The
   "1 day to build" estimate is contingent on whether
   `Adrian/p15/test-framework/src/promptarmor-baseline.ts` already exists.
   Verify *before* costing T-2 — a 30-second `ls` of that directory pins
   the estimate.

3. **T-3 has a hidden second branch.** `benchmarks/mt_agentrisk/runs/`
   being empty while the paper cites MT-AgentRisk numbers means the
   AIDredd baseline data may not be reproducibly stored. If we can't
   locate the historical AIDredd MT-AgentRisk runs, **both arms** need
   rerunning, doubling T-3's cost from ~6h → ~12h and ~$25 → ~$50. The
   inventory step is non-negotiable; budget the worst case.

4. **T-5 (composite PromptArmor ∥ AIDredd) belongs in P0, not P1.** The
   defence-in-depth claim is one of the paper's distinctive contributions
   vs PromptArmor's standalone framing. ~2h / ~$7 is low enough that
   demoting it to "recommended, not strictly required" reads as budget
   dressing. Promote to P0; it gives the paper the orthogonality
   evidence the §7 claim leans on.

5. **Wall-time vs serial-time.** Estimates in the table are serial
   compute, not wall-clock. The phaseC-2026-05-12 head-to-head ran
   three independent runs concurrently on bedt3/4/5; the same dispatch
   pattern collapses 25–33h serial → ~6–10h wall if T-2/T-3/T-4 are
   parallelised across containers. Plan accordingly when scheduling.

6. **All new runs must be on v0.1.363+.** Two bugs landed in the
   v0.1.360 → 0.1.363 sequence that affect any benchmark run with a
   long transcript or many intent entries:
   - DynamoDB META 400KB ceiling (fixed by per-row INTENT# split,
     v0.1.360).
   - macOS ARG_MAX truncation of UserPromptSubmit body for transcripts
     >1MB (fixed by `transcript_summary` envelope + tempfile POST,
     v0.1.362).
   Pre-v0.1.363 runs of T-3 / T-4 / T-5 risk silent state loss on
   sessions that exceed either threshold. **Confirm the deployed hook
   image is v0.1.363+ before kicking off P0 runs.**

7. **Total budget likely under-stated in the table.** T-3's worst-case
   branch (rerun both arms) and T-2's adapter-build branch both add
   meaningful time. Realistic ceiling for P0+P1 with worst-case
   contingencies: ~40h serial / ~$130 spend, vs the doc's 25–33h /
   ~$100. Still well under the $250 plan cap, but worth flagging
   before sign-off.

The original ranking (T-1 → T-3 → T-2 → T-4 → T-5 → T-6 → T-7 → T-10)
remains correct under these caveats; only T-5's promotion changes the
P0 vs P1 split.

8. **B-1 is no longer a bug to fix before runs.** Tracing through
   `src/promptarmor-baseline.ts:198-212` shows `sanitisation_failed`
   is the expected output of `fuzzyStrip` when detector quotes don't
   token-match content — it's a faithful reproduction of PromptArmor's
   per-paper §3.1 strip algorithm, not a crash in our code. Updated
   B-1 below to reflect this. **No T-2/T-3/T-4 reruns needed.**

9. **Suggested execution order updates after dispatch on 2026-05-13.**
   Already running:
   - T-1 sonnet × B7.1 on bedt5 (started 20:42Z, ~80m wall).
   - T-4 banking on bedt4 (qwen3-32b × banking, started 20:57Z).
   These were dispatched in parallel; previous bedt3/4/5 phaseC
   showed ~3-4× speedup vs serial.

10. **D-2 unresolved from this checkout.** `Adrian/p15/test-framework/`
    is not present in `~/IdeaProjects/` or any depth-8 subtree of
    `~`. Either the framework lives outside this machine or it's at
    a path not yet visible to the search. Until verified, **assume
    the +1day adapter-build branch on T-2** (cost: ~14h instead of
    ~6h).
