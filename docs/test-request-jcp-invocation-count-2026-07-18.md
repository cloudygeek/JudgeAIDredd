# Data reconciliation request — "16,000+ judge invocations" scale claim (p15a/defence)

**Date:** 2026-07-18
**Requested by:** Second (independent) JCP peer review of the defence paper
(`Cloud-Security/Adrian/p15b/PEER_REVIEW_p15b-defence_2026-07-17_fable_v2.md`, M3 + M4).
**Paper:** `Adrian/p15b/p15b-defence.tex` and `Adrian/p15b/mdpi-jcp/p15b-jcp.tex`.
**Priority:** MEDIUM — gates the JCP revision. This is the paper's headline **scale** claim
(in the abstract), so it must be derivable and reconcile with the tables/census.
**Type:** count/aggregate from durable data — **no new agent runs**. If it needs a re-run, flag back.

---

## The problem (reviewer M3)

The abstract/intro claim **"16,000+ judge invocations"** (`p15b-defence.tex` l.28/30/63/202, census
caption l.207). But §`sec:adversarial` reports the calibration sweep alone produced
**"13,156 baseline evaluations"** for the ECE analysis (l.267).

If the single-turn calibration baseline sweep already yields 13,156 judge calls, then adding the
prompt-v1 and prompt-v2 cells **plus** the five cross-corpus Stage-3 fires should push the total
*far above* 16,000 — OR, if 16,000 is the true grand total, the five corpora contribute only
~3,000 invocations and "spanning five corpora" overstates where the breadth comes from. Either way
the number is not currently derivable, and the evaluation census (Table 1) does not sum to it.

## What we need (look-up / aggregate)

**1. Definition.** What does one "judge invocation" count?
   - (a) Stage-3 LLM-judge *fires only* (i.e. calls that reached the LLM after the Stage-1 policy /
     Stage-2 embedding early-exit), or
   - (b) every verdict emitted (including deterministic early-exits), or
   - (c) something else.
   The latency section says the judge fires on only ~1.6–2.8% of tool calls under enforcement, so on
   the cross-corpus attack runs the number of *actual LLM judge calls* is far smaller than the number
   of cases — which is likely why the total is "only" ~16k. Confirm which definition makes 16,000+
   correct, and use it consistently.

**2. Additive breakdown.** Give the invocation count per source so the total reconciles:
   - calibration **baseline** sweep (the 13,156 figure — confirm it, and confirm it is judge calls
     not case-evaluations);
   - calibration **prompt-v1** cells;
   - calibration **prompt-v2** cells (the format-variant matrix);
   - each corpus's Stage-3 judge fires under the defended arm: T3e, T5, crack-vector, AgentDojo,
     MT-AgentRisk, AgentLAB, InjecAgent;
   - the false-positive workload;
   - anything else that feeds the total.
   Then: **does it sum to 16,000+?** If the true total is materially different (e.g. the calibration
   sweep alone already exceeds 16k on definition (b)), give the corrected headline number.

**3. Census reconciliation (reviewer M4).** Two census (Table 1) cells undercount:
   - **Calibration row** says "3 judges × 3 prompts", but §`sec:adversarial` (l.248) evaluates
     **≥8 judge models at baseline** (Claude Haiku 4.5 / Sonnet 4.6 / Opus 4.7 + Nova Micro / Nova Pro
     / Nova Lite / Nemotron-120B / Qwen3-32B). Confirm the exact count of judge models run **at
     baseline** vs at **v1/v2** (v1/v2 appear to be the 3 Anthropic judges only). This is being
     corrected to "8 judges (baseline), 3 (v1/v2)" — confirm 8 is right.
   - **AgentDojo row** says "6 agents" but `tab:promptarmor-headtohead` tabulates **5** AgentDojo
     agents (Sonnet 4.6, Opus 4.7, GPT-4o-mini, Qwen3-32B, Qwen3-235B — Opus 4.8 absent). Confirm 5.

## What to return

A short `results/p15a-invocation-census-2026-07-18/RESULTS.md` (matching the prior reconcile pattern):
- the definition (a/b/c) that makes the headline correct,
- the additive per-source table that sums to the total,
- the corrected headline number if 16,000+ is wrong,
- the confirmed baseline judge-model count (8?) and AgentDojo agent count (5?).

Per-source counts are enough — no trajectories, no new runs. If any source count is not recoverable
from the durable logs/JSONs, say so explicitly rather than estimating.
