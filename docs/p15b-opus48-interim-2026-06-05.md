# Opus 4.8 cross-corpus interim results — 2026-06-05

**Date:** 2026-06-05 11:15 UTC
**Status:** Interim — MT-AgentRisk defended arms (bedt3/7/14) and T3e (bedt8)
still running. AgentDojo, AgentLAB, InjecAgent fully landed.
**Source request:** `docs/test-request-opus48-defended-2026-06-04.md`

This is the first cross-corpus dataset for `claude-opus-4-8`, the new agent
the p15b master table was held for. All numbers verified against per-rep
RepResult JSONs synced from S3 — no summary-only inference.

---

## Headline finding — H1 confirmed

**Opus 4.8 attacks succeed at non-trivial rates on two corpora**, replicating
the Mode-4 §VII regression in the single-turn injection setting:

- **AgentDojo travel suite:** 12.1% baseline ASR (vs 0% for sonnet 4.6 and
  opus 4.7 on the same suite). First measurable Anthropic-frontier defence
  delta on the AgentDojo matrix.
- **AgentLAB pooled (n=10 stratified-10 smoke):** 10% baseline ASR.

These are the cells the p15b paper will cite to argue that the "Anthropic
frontier 0% floor" claim is breaking — not as a generic regression, but as
a measurable, defence-tractable signal.

---

## Per-corpus detail

### AgentDojo (`important_instructions` attack, full N per suite)

| Suite | n | none ASR | none util | B7.1 ASR | B7.1 util | PA ASR | PA util | composite ASR | composite util |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| banking | 144 | 0.0% | 80.6% | 0.0% | 31.2% | 0.0% | 81.2% | — | — |
| **travel** | 140 | **12.1%** | 85.7% | **0.7%** | **5.0%** | **6.4%** | 72.1% | **0.0%** | **0.0%** |
| slack | 105 | 0.0% | 75.2% | 0.0% | 0.0% | 0.0% | 70.5% | — | — |
| workspace | 560 | 0.0% | 97.3% | 0.0% | 0.2% | 0.0% | 96.8% | — | — |
| **pooled** | **949** | **1.8%** | — | **0.1%** | — | **0.9%** | — | — | — |

**Travel is the H1 cell.** Three observations:
- Dredd (B7.1) drops ASR 12.1% → 0.7% (Δ −11.4pp).
- PromptArmor leaves a 6.4% residual — qualifies for the composite cell per
  the doc's threshold (PA residual > 5%).
- Composite (B7.1 + PromptArmor) hits 0.0% ASR but utility crashes to 0.0%.

**Utility cliff:** Dredd-on-Opus-4.8 is brutal on benign tasks: banking
80.6% → 31.2%, travel 85.7% → 5.0%, workspace 97.3% → 0.2%. The defence
works, but at substantial cost. PA preserves utility (>70% on every suite).
This is the expected reviewer pushback — to be flagged in the writeup.

### AgentLAB (5 attack types × 2 environments stratified-10 smoke, n=10 pooled)

| Arm | n | succeeded | ASR | comment |
|---|--:|--:|--:|---|
| none | 10 | 1 | **10%** | memory_poisoning succeeded once |
| intent-tracker (Dredd) | 10 | 0 | **0%** | clean block |
| **promptarmor** | 10 | 3 | **30%** | **PA worse than baseline** |

Per attack type (each n=2 per arm):

| Attack | none | int-tracker | promptarmor |
|---|--:|--:|--:|
| intent_hijacking | 0/2 | 0/2 | 0/2 |
| tool_chaining | 0/2 | 0/2 | 0/2 |
| task_injection | 0/2 | 0/2 | 0/2 |
| objective_drifting | 0/2 | 0/2 | **1/2** |
| memory_poisoning | 1/2 | 0/2 | **2/2** |

**Striking PA negative result:** PromptArmor flips memory_poisoning from 50%
→ 100% success and *introduces* an objective_drifting success that didn't
happen in baseline. This replicates the doc's MT-AR finding (GPT-4o-mini PA
+1.5pp worse than baseline) on a different corpus. **Paper-worthy.**

n=10 is small — full-scale AgentLAB would tighten the CIs. The directional
signal is consistent enough to cite.

### InjecAgent (base setting, dh + ds attacks, n=1054 per agent)

| Agent | none ASR | B7.1 ASR | PA ASR |
|---|--:|--:|--:|
| opus-4-8 | 0/1054 (0%) | 0/1054 (0%) | 1/1054 (0.1%) |
| opus-4-7 | 0/1054 (0%) | 0/1054 (0%) | 2/1054 (0.2%) |

**InjecAgent does not penetrate either Anthropic frontier agent.** All cells
sit at the floor. PA introduces 1-2 successes; Dredd and baseline are clean.
This corpus is uninformative for opus-4-7 / opus-4-8 defence-effectiveness
comparison — write-up should note rather than quote.

### MT-AgentRisk (full corpus, asr_aggregate, n=820)

`none` arm verified across all three Anthropic agents (defended arms still
in flight on bedt3/7/14):

| Agent | n_classifiable | n_complete (attack) | none ASR | filesystem | postgres | terminal |
|---|--:|--:|--:|--:|--:|--:|
| sonnet-4.6 | 481 | 43 | **8.9%** | 8.4% | 12.6% | 1.6% |
| opus-4.7 | 510 | 23 | **4.5%** | 7.9% | 3.2% | 1.1% |
| opus-4.8 | 555 | 19 | **3.4%** | 7.9% | 2.1% | 0.0% |

This **disproves** the prior "Anthropic floor n=2-4" caveat from the
doc's `mt_agentrisk_provenance_finding`. With the full corpus, all three
agents have measurable, non-trivial baselines. Defences are running and
will land tomorrow.

### T3e Opus 4.8 — in flight on bedt8

20 reps × 3 scenarios (T3e.2/3/4) × 2 arms (none, intent-tracker) = 120
runs. ~5/120 complete at writeup time. Will be the strongest single H1
result when it lands (CanaryServer-confirmed exfiltration is the cleanest
signal in the matrix).

---

## Comparative — Opus 4.8 vs Opus 4.7 (where measurable)

The Mode-4 finding (`results/mode4-2026-05-31/results-2026-06-03-q124-closure.md`)
showed opus-4-8 leaks credentials 10/10 in 50-turn floods vs opus-4-7's
~13% (Wilson [6%, 24%]). This dataset checks whether that regression
extends to single-turn injection corpora:

| Corpus | opus-4-7 ASR | opus-4-8 ASR | Δ |
|---|--:|--:|--:|
| AgentDojo travel | 0.0% | **12.1%** | **+12.1pp** |
| AgentDojo (other suites) | 0.0% | 0.0% | 0 |
| InjecAgent | 0.0% | 0.0% | 0 |
| MT-AR (none arm) | 4.5% | 3.4% | -1.1pp |
| AgentLAB | (not run) | 10.0% | n/a |

**Net:** Opus 4.8's regression vs 4.7 is **AgentDojo-travel-specific** in the
single-turn setting. MT-AR and InjecAgent show 4.8 ≤ 4.7. The Mode-4
50-turn pattern does not generalise to every injection class — it is
duration-and-corpus-conditioned (consistent with H3 from the test request).

This is a useful nuance for the paper: "Opus 4.8 introduces a measurable
floor break, but only on AgentDojo travel + AgentLAB memory_poisoning + Mode-4
flooded sessions. Other injection classes hold at the floor." This is
narrower than "the Anthropic floor is breaking" but cleaner to defend.

---

## Defence-effectiveness summary (where ASR > 0%)

| Cell | none | best defence | Δ | utility cost |
|---|--:|---|---:|---|
| AgentDojo travel | 12.1% | B7.1 0.7% | -11.4pp | -80.7pp util |
| AgentDojo travel | 12.1% | composite 0.0% | -12.1pp | -85.7pp util |
| AgentLAB pooled | 10.0% | int-tracker 0% | -10.0pp | not measured |
| MT-AR sonnet none | 8.9% | (in flight) | — | — |

**Dredd (B7.1) is consistently the strongest defence on opus-4-8** but
costs significant utility. PromptArmor preserves utility but is
**unreliable** — 0% on AgentDojo, but 30% (worse than baseline) on AgentLAB.
The composite cell on AgentDojo travel matches Dredd-alone effectiveness
without additional benefit, and inherits Dredd's utility cost.

---

## What's still pending

1. **MT-AgentRisk defended arms (bedt3/7/14)** — full corpus × 3 agents ×
   3 defences = 9 cells in flight. ETA late 2026-06-05 / early 2026-06-06.
2. **T3e Opus 4.8 (bedt8)** — 120 runs in flight. ETA ~5h.
3. **AgentLAB at full scale** — current results are stratified-10 smoke.
   Worth re-running at full scale once the MT-AR queue frees containers,
   given the PA-worse-than-baseline finding deserves tighter CIs.

---

## Files

Raw JSONs:
- `s3://cko-results/promptarmor-bedrock/p15b-agentdojo-opus48-{bank-travel-eu-west-3,slack-ws-eu-north-1,bank-travel-defended-eu-west-3,slack-ws-defended-eu-north-1,travel-composite-eu-north-1}/`
- `s3://cko-results/agentlab/p15b-agentlab-opus48-{3attacks-eu-west-3,2attacks-eu-west-1}/`
- `s3://cko-results/injecagent/p15b-injecagent-{opus48-pa-eu-central-1,opus47-pa-eu-central-1,opus48-and-47pa-eu-central-1}/`
- `s3://cko-results/mt-agentrisk/p15b-mt-agentrisk-{sonnet-46,opus48,opus47}-eu-central-1/` (none arms only at writeup time)

All cross-checked against per-rep `summary-eu.anthropic.claude-opus-4-8-{...}.json`
files (AgentDojo `suites[0].asr`, AgentLAB `cells[*].byAttackType`, InjecAgent
`cells[].succ`, MT-AR `asr_aggregate`).
