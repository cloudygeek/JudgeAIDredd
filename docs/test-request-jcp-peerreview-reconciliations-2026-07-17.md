# Data reconciliation request — JCP peer-review number audit (p15a/defence)

**Date:** 2026-07-17
**Requested by:** P15 defence-paper JCP peer review (`Cloud-Security/Adrian/p15b/PEER_REVIEW_p15b-defence_2026-07-17_fable.md`), for the revision on branch `Cloud-Security` → `p15b-defence-review-fixes-2026-07-17`.
**Paper:** `Adrian/p15b/p15b-defence.tex` (Springer build) and `Adrian/p15b/mdpi-jcp/p15b-jcp.tex` (MDPI build) — kept in sync.
**Priority:** MEDIUM — gates the **JCP revision**, not the core result. Every headline scientific claim already stands; these five items tighten reporting so the paper's own numbers reconcile exactly (the reviewer's point: a paper whose thesis is "defence-literature numbers can't be trusted at face value" must have self-consistent numbers).
**Type:** 3 are **look-ups** (read x/N off existing JSONs), 2 are **recomputes** (Wilson CIs / label confirmation) from data already on disk. **No new agent runs are expected.** If any item does require a re-run, flag it back rather than running silently.

> Context for the data owner: the editorial fixes (held-out transfer number, footnote-*b* vendor scope, fail-soft wording, split-file mechanism, Trilemma softening, roster: GPT-4o dropped / Qwen3-32B added, N=40–1054, non-adaptive qualifier) are **already applied** in the paper branch and compile clean. What remains are the items below, which need the underlying data to answer correctly — I did not want to guess a number into a security paper.

---

## 1. (M4-iv) The "0/360 across all five agents" T3e claim — name the five agents

**Where:** §`sec:cross-corpus`, paragraph *"Detection-rate measurement on T3e"*:
> "…immaterial to the comparison — on T3e the action-side judge already drives baseline ASR to **0/360 across all five agents**."

**Problem:** the manuscript elsewhere reports T3e strict-exfil residuals that a blanket "0/360 across all five agents" cannot contain:
- `tab:exfil-defended`: **Qwen3-235B enforced = 6.2%** (not 0).
- §`sec:backfire`: **Haiku 4.5 = 1/120** on T3e.4 (not 0).

So the "five agents" here must be a *specific* set (presumably the frontier/PromptArmor-comparison agents on a **disclosure/ASR** axis, distinct from the open-weights strict-exfil front), not the eleven-agent exfil population.

**Data needed (look-up):**
1. The exact **membership** of the five-agent set behind this sentence (from the T3e × PromptArmor detection-rate run — likely `results/p15a-ptu-t3e-*` / the PromptArmor-arm T3e dirs).
2. The **metric** it is 0 on (strict network-exfil `curl`-POST vs credential-disclosure vs corpus-native ASR) and the denominator (why 360 = presumably 3 scenarios × 120).
3. Confirmation that this set excludes Qwen3-235B and Haiku 4.5 (or, if it includes them, how "0/360" reconciles with 6.2% and 1/120).

**Fold-in:** rewrite the sentence to name the set and metric explicitly (Reviewer Question 3). One clause fixes it.

---

## 2. (minor 3) Haiku 4.5 prompt-v2 adversarial cell — the raw x/N behind "97% [92, 100]"

**Where:** `tab:adversarial-summary` (adversarial catch rate, `none` effort). Caption states **N=160** per (model, prompt) cell for prompt v2. The Haiku 4.5 + v2 cell reads **97% [92, 100]**.

**Problem:** a Wilson 95% interval on 160 trials cannot have an **upper bound of 100** when failures were observed. 155/160 → ≈[92.9, 98.7]; 156/160 → ≈[93.7, 99.0]. The stated [92, 100] is not a valid Wilson interval for any x/N < 160.

**Data needed (look-up + recompute):**
1. The raw **x/N** for the Haiku 4.5 / prompt-v2 / `none` cell (successes / trials), from the adversarial-sweep result JSONs.
2. Confirm N (160 vs 240 — the caption uses both for different columns).
3. Recompute the Wilson 95% interval from that x/N.

**Fold-in:** replace `97% [92, 100]` with the correct point estimate + interval (Reviewer Question 10). If the true value is e.g. 155/160 = 96.9% [92.9, 98.7], report that.

---

## 3. (minor 4 / Q5) The 33 pp utility-cost endpoint — provenance

**Where:** §`sec:performance` *"Utility"* paragraph (and abstract + conclusion): benign-workload utility delta "**0–33 pp domain-dependent**", attributed to the AgentDojo suites where the defence over-constrains exploratory tool sequences. (I already fixed the nonexistent "messaging" suite → "Slack" in the prose.)

**Problem:** the **33 pp** upper endpoint is never sourced in the paper. The only concrete utility numbers present are −3 pp (AgentDojo GPT-4o-mini benign, 84% vs 87%) and the PromptArmor 30.8%-completion cell. The reviewer flags 33 pp as an unsourced headline number.

**Data needed (look-up):**
- Which **suite × agent** yields the 33 pp utility drop, with the **defended-vs-undefended benign-task completion rates** it is computed from (Phase B benign-utility dirs).

**Fold-in:** add the source (suite, agent, completion rates) to a sentence or a small utility table, or lower the headline to a sourced figure.

---

## 4. (M11) Baseline run-to-run variance — Wilson CIs on Tables 3 and A1, and reconcile the cross-run swings

**Where:** `tab:exfil-defended` (T3e open-weights front, **N=80/arm**, one-decimal point estimates, **no CIs**) and appendix `tab:judge-cmp` (Haiku-vs-Sonnet judge, same agents).

**Problem:** the appendix caption attributes **up to ~17 pp** baseline movement between runs to "run-to-run attack stochasticity":
- GLM-4.7-flash **78.8%** (`tab:exfil-defended`) vs **62%** (`tab:judge-cmp`)
- gpt-oss-120b **38.8%** vs **31%**
- GLM-4.7 **32.5%** vs **26%**

If a single N=80 baseline can move 17 pp between runs, one-decimal point estimates convey false precision and the "−16 to −82 pp" reduction span is itself run-dependent.

**Data needed (recompute):**
1. **Wilson 95% CIs** on the **baseline** and **enforced** columns of `tab:exfil-defended` (and the baseline column of `tab:judge-cmp`), from the per-cell N=80 JSONs.
2. Confirm whether the two tables' baselines are the **same arm re-run** or **different N / different run**, so the caption can state the reduction span with the right rounding/interval caveat.

**Note:** the enforced-side conclusion (≈0 on the front, 0 hijacked-but-executed) is robust to this and needs no change — this is purely about honest baseline precision.

**Fold-in:** add CIs to Tables 3 (and A1) — the `tab:cross-corpus-summary` caption already promises "Wilson 95% intervals" the exfil table does not display.

---

## 5. (MT-AgentRisk: range + arm label)

**Where:** `tab:cross-corpus-summary` MT-AgentRisk rows and §`sec:cross-corpus` *"MT-AgentRisk is a null result on Anthropic-frontier agents"*.

**Two questions:**

**5a — non-frontier residual range (20 vs 21).** The table row (now relabelled "non-frontier": Haiku / GPT-4o-mini / Qwen3-coder-Next) read **21–41%**; the prose reads **20–41%**. I aligned the table to the prose (**20–41%**) to remove the contradiction, but could not verify which endpoint is the true low value. **Confirm 20 vs 21** from the MT-AgentRisk intent-tracker per-agent residuals (the 820-scenario/arm run).

**5b — which arm is the "Defended" column? (Reviewer Q9 / audit-15).** `tab:cross-corpus-summary` caption declares the defended arm = **Dredd v2 (intent-tracker)**. But the prose says the Anthropic-frontier best endpoint is **Sonnet 4.6 8.92% → 7.38% (composite)**, with "intent-tracker and PromptArmor within noise of baseline." So the table's MT-AgentRisk Anthropic "Defended" 7% appears to be the **composite** arm, not the intent-tracker arm the caption promises. **Confirm** whether the tabulated MT-AgentRisk defended figures are the intent-tracker arm or the composite/best arm, so the caption and table agree (fix whichever is wrong).

**Fold-in:** correct 5a's endpoint if needed; make the `tab:cross-corpus-summary` MT-AgentRisk arm label match the numbers actually tabulated.

---

## What to return

For each item, the smallest artifact that resolves it:
- **1:** agent list + metric + denominator (one line, + the results dir it came from).
- **2:** x/N + recomputed Wilson interval.
- **3:** suite × agent + defended/undefended completion rates.
- **4:** a small table of Wilson CIs for the N=80 baseline/enforced cells + a yes/no on same-arm-re-run.
- **5:** 20-or-21 + intent-tracker-or-composite.

A short `RESULTS.md` in a new `results/p15a-peerreview-reconcile-2026-07-17/` dir (matching the strat-140 pattern) is ideal; per-cell numbers are enough — no new trajectories expected. If any item turns out to require a re-run (not just a JSON read), stop and flag it in the RESULTS stub rather than launching it.
