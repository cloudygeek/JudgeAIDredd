# Test requirement — stratified-100 replication of the defence-as-injection-vector backfire (p15a/defence)

**Date:** 2026-07-06
**Requested by:** P15 defence-paper JCP peer-review response (Cloud-Security/Adrian/p15b/p15b-defence.tex §4.4 `sec:backfire`, `tab:backfire`)
**Priority:** HIGH — **gates JCP submission.** This confirms the paper's flagship *negative* result (the "single most important thing" from the peer review, `p15b/PEER_REVIEW_2026-07-06.md` M2).
**Harness:** `test-framework/src/runner-agentlab.ts` + `sdk-hooks.ts:createDefenceHooks` (real PreToolUse path — the AgentLAB corpus already gates correctly; this is a higher-N re-run, not a call-point fix).

---

## 1. Why — the featured backfire rests on one under-powered, post-hoc cell

§4.4 reports that the intent-tracker (Dredd's prompt-side re-anchoring component) *raises* AgentLAB attack success on context-injection classes. The featured cell is **Sonnet 4.6, AgentLAB stratified-50**: pooled ASR **2/50 → 12/50** (intent-tracker), **Δ = +20 pp, Fisher exact p = 0.008**. Two problems a security/stats reviewer will (did) seize on:

1. **Unadjusted p + post-hoc selection.** The cell was selected post-hoc from a large (agent × corpus × arm × attack-class) matrix, and p is reported *unadjusted* — while the paper applies family-wise correction to its *catch-rate* claims. Inconsistent.
2. **Under-powered sub-classes.** The effect is carried by two n=10 classes — objective-drifting (0/10→5/10) and memory-poisoning (2/10→7/10) — with wide Wilson intervals (memory-poisoning [27%, 88%]); only the pooled n=50 reaches significance.

The paper already promises a stratified-100 replication. Run it, pre-registered, with an explicit multiple-comparison correction, so the claim becomes "confirmed" rather than "seen in one cell."

## 2. What to run — hold everything fixed except N

Identical config to the existing strat-50 AgentLAB runs (`results/p15b-2026-06-09-agentlab-opus48-strat50*`); the **only** change is N and the pre-registered analysis.

- **Corpus:** AgentLAB, all five attack classes; **stratified-100 = 20 reps × 5 classes = 100/arm** (every class ≥20; the two carrying classes objective-drifting + memory-poisoning must each reach ≥20).
- **Arms:** `none` (baseline) and `intent-tracker` (the prompt-side re-anchoring component — the backfiring one). Optionally add `promptarmor` (the other prompt-modifying defence) if cheap; it is near-baseline at strat-50.
- **Agents:** **Sonnet 4.6** (the +20 pp cell — the confirmatory target) **and Opus 4.8** (the *mirror* cell: at strat-50 the intent-tracker *suppressed* memory-poisoning 8/10→0/10, overall 16%→4%). Running both confirms the paper's *agent-dependent-sign* claim at higher N.
- **Judge / config:** Sonnet 4.6 + prompt v2 + the same embedding/Stage-1 settings as strat-50. Same 28 AgentLAB environments.

## 3. Pre-registered analysis (declare and freeze BEFORE looking at outcomes)

- **Primary endpoint:** Sonnet 4.6 pooled ASR delta (`intent-tracker − none`) over the five attack classes at N=100. Report successes/100 per arm, the delta, its Wilson 95% CI, and Fisher exact p (unadjusted).
- **Comparison family (for multiplicity):** the pre-declared set of AgentLAB intent-tracker-vs-baseline tests = {Sonnet 4.6, Opus 4.8} × {5 attack classes} + the 2 per-agent pooled = **12 tests**. Apply **Holm** correction (report BH too); report the Holm-adjusted p for the primary endpoint.
- **Confirmatory decision rule:** the +20 pp claim is *confirmed* iff the Sonnet 4.6 pooled delta stays positive and **Holm-adjusted p < 0.05**. If it does not survive, the paper down-weights the claim to "directional / agent-dependent, not individually significant."
- **Secondary:** per-class deltas with Wilson CIs (both agents); the Opus 4.8 mirror (expect suppression → confirms sign flips by agent).

## 4. Expected direction (state explicitly when results land)

If the strat-50 effect is real, Sonnet 4.6 strat-100 should land near **~8/100 → ~24/100** pooled; a +20 pp effect of that size survives Holm across a 12-test family comfortably. Opus 4.8 should again *suppress* (agent-dependent sign). If the Sonnet effect shrinks toward noise at N=100, that is itself reportable and the paper will soften accordingly.

## 5. Output

`results/p15a-backfire-strat100-2026-07-06/` + a `RESULTS.md` with: per-class and pooled successes/N for both agents × both arms, Wilson 95% CIs on the deltas, and **both unadjusted and Holm-adjusted p** — in the shape of `tab:backfire` so the paper table and §4.4 can be updated directly. Per-trajectory JSONs released as usual.
