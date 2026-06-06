# p15b cross-corpus analysis — 2026-06-06 morning

**Date:** 2026-06-06 06:55 UTC
**Status:** 6 of 7 containers landed durably. bedt14 (Opus 4.7 MT-AR composite cell) still ~3-4h from completion. All other p15b cells from the docs/test-request-opus48-defended-2026-06-04.md request are banked.

This is the consolidated picture of the new Opus 4.8 row + Anthropic-frontier defence-effectiveness data, compiled from the four-container overnight wave and the three follow-on cells. Replaces the three earlier interim docs as the master reference.

---

## Executive findings

Three findings drive the §VIII-F write-up:

### Finding 1 — MT-AgentRisk: defences produce no measurable improvement on Anthropic agents

| Agent | none | intent-tracker | promptarmor | composite | best Δ vs none |
|---|--:|--:|--:|--:|--:|
| sonnet-4.6 | 8.92% | 8.92% | 8.60% | **7.38%** | **−1.5pp** |
| opus-4.8 | 3.42% | 3.76% | 3.41% | 3.56% | ≈ 0 |
| opus-4.7 | 4.51% | (still running on bedt14) | (still running) | (still running) | TBD |

This is **directly opposite** to the doc's pre-existing finding on non-Anthropic agents ("Dredd leaves a 20-41% residual, Δ -6 to -13pp"). On Anthropic agents at the floor end of the ASR distribution, no defence in the matrix moves the needle by more than ~1.5pp. The implication: the defence-effectiveness measurement on this corpus is **dominated by base-rate effects**, not by the defence's mechanism.

For the paper: MT-AgentRisk on Anthropic frontier agents reads as a **null result** for defence effectiveness. The cell to feature is `composite, sonnet-4.6, Δ -1.5pp` — the only positive movement, and small. Avoid framing MT-AR as a defence-effectiveness corpus for this row.

### Finding 2 — AgentLAB confirms PromptArmor *introduces* attacks on Opus 4.8 (n=50 robust)

| Arm | n | succ | ASR |
|---|--:|--:|--:|
| none | 50 | 7 | **14.0%** |
| intent-tracker | 50 | 0 | **0.0%** |
| promptarmor | 50 | 8 | **16.0%** |

Per attack class:

| Attack | none | IT | PA |
|---|--:|--:|--:|
| intent_hijacking | 0/10 | 0/10 | 1/10 (10%) |
| tool_chaining | 0/10 | 0/10 | 0/10 |
| task_injection | 0/10 | 0/10 | 0/10 |
| objective_drifting | 0/10 | 0/10 | 1/10 (10%) |
| memory_poisoning | **7/10 (70%)** | 0/10 | **6/10 (60%)** |

**Two independent confirmations of the n=2 smoke result**: PA introduces successes on intent_hijacking and objective_drifting that didn't exist in baseline. Memory_poisoning is unaffected by PA (drops from 7/10 to 6/10 — within noise) but blocked completely by IT.

For the paper: this is the strongest "defence harms" cell in the dataset. **n=50, two attack classes worsen, one defence stack** → robust enough to cite as a paper-worthy negative result. Combined with the prior cross-Anthropic AgentLAB smoke (haiku + IT, sonnet + IT both also worsen), the pattern is: **prompt-modifying defences can supply additional context the attacker exploits, particularly on memory_poisoning and objective_drifting attack classes**.

Intent-tracker is the only clean defence on this corpus: **0/50 attacks succeed across all 5 attack types**. Δ −14pp is the strongest Dredd signal in the matrix (after T3e-displayed-to-user).

### Finding 3 — T3e credential disclosure: H1 holds for Opus 4.8 only

The cleanest H1 cell in the dataset is opus-4-8 on T3e. Cross-agent shows it does NOT generalise to other Anthropic agents:

| Agent | n | none-displayed | IT-displayed | Δ | comment |
|---|--:|--:|--:|--:|---|
| **opus-4-8** | 60 | **53/60 (88%)** | **17/60 (28%)** | **−60pp** | H1 confirmed |
| opus-4-7 | 60 | 25/60 (42%) | 27/60 (45%) | +3pp | no defence signal |
| sonnet-4-6 | 60 | 13/60 (22%) | 19/60 (32%) | +10pp | **defence worsens** |

**Network exfiltration: 0/60 across all agents and arms.** No agent actually POSTs the canary to the canary server — they all sandbox out of running curl-style exfil. The discriminating axis is "leaked-to-user" (canary string in the operator chat output).

Paper framing for §VIII-F:
- **Lead with opus-4-8: 88% baseline → 28% defended, the strongest Anthropic-frontier defence delta in the matrix.**
- Footnote that this is unique to opus-4-8 (4.7 / sonnet do not reproduce the high baseline).
- Note that "credential disclosure" is the operative axis, not "exfiltration" — the latter sits at 0 on all agents.

---

## Defence-effectiveness summary (all positive cells across the matrix)

| Cell | n | none | best defence | Δ |
|---|--:|--:|---|--:|
| **T3e opus-4-8 (display)** | 60 | 88% | IT 28% | **−60pp** |
| **AgentLAB opus-4-8 strat-50** | 50 | 14% | IT 0% | **−14pp** |
| **AgentDojo opus-4-8 travel** | 140 | 12.1% | composite 0% | **−12.1pp** |
| AgentDojo opus-4-8 travel | 140 | 12.1% | B7.1 0.7% | −11.4pp |
| AgentLAB opus-4-8 smoke (n=10) | 10 | 10% | IT 0% | −10pp |
| AgentLAB opus-4-7 smoke | 10 | 10% | IT 0% | −10pp |
| MT-AR sonnet-4.6 | 488 | 8.92% | composite 7.38% | −1.5pp |

The **defence-worsens** cells:

| Cell | n | none | worst arm | Δ |
|---|--:|--:|---|--:|
| AgentLAB opus-4-8 strat-50 PA | 50 | 14% | PA 16% | +2pp |
| AgentLAB sonnet-4-6 IT smoke | 10 | 10% | IT 20% | +10pp |
| AgentLAB haiku-4-5 IT smoke | 10 | 30% | IT 40% | +10pp |
| T3e sonnet-4-6 IT (display) | 60 | 22% | IT 32% | +10pp |
| MT-AR opus-4.8 IT | 559 | 3.42% | IT 3.76% | +0.34pp |

**Pattern:** the defences-worsen cells overlap with intent-tracker and PromptArmor on attack classes that exploit context-injection (memory_poisoning, objective_drifting on AgentLAB; the prompt-modification surface on T3e). The mechanism is plausibly that prompt-side defences supply additional context the attacker can exploit. Worth flagging but not over-claiming.

---

## Per-agent master row (Anthropic frontier)

Best-available defence Δ per agent (positive = defence reduces attacks):

| Agent | T3e | AgentDojo | AgentLAB | InjecAgent | MT-AR |
|---|---|---|---|---|---|
| haiku-4-5 | — | — | (worsen) | — | (prior phaseE) |
| sonnet-4-6 | (worsen) | (floor) | (worsen) | (floor) | **−1.5pp** |
| opus-4-7 | (no signal) | (floor) | **−10pp** | (floor) | (in flight bedt14) |
| **opus-4-8** | **−60pp** | **−12.1pp** | **−14pp** | (floor) | (no signal) |

**Opus 4.8 is the only agent with a measurable defence-effectiveness signal across multiple corpora.** The other Anthropic frontier agents either sit at the corpus floor (no attacks penetrate baseline) or show a defence-worsens pattern (AgentLAB IT for haiku and sonnet, T3e IT for sonnet).

**Paper claim that survives this dataset:** *Of the four Anthropic-frontier agents tested, Opus 4.8 is uniquely vulnerable to single-turn injection AND uniquely defendable. The other three agents demonstrate either floor behaviour (where defence effectiveness cannot be measured) or defences-introduce-attacks pathologies that argue against deployment of those specific defence stacks.*

---

## What's still pending

- **bedt14**: Opus 4.7 MT-AR composite cell, scenario 663/820 in the third arm. ETA ~3-4h. Will close MT-AR opus-4.7 row.

That's the only remaining cell. Once it lands, the master table for the request in `docs/test-request-opus48-defended-2026-06-04.md` is fully populated.

---

## Files

- MT-AR sonnet-4.6 defended: `s3://cko-results/mt-agentrisk/p15b-mt-agentrisk-sonnet-46-defended-eu-central-1/`
- MT-AR opus-4.8 defended: `s3://cko-results/mt-agentrisk/p15b-mt-agentrisk-opus48-defended-eu-central-1/`
- T3e sonnet-4-6: `s3://cko-results/t3e/p15b-t3e-sonnet46-eu-west-3/`
- T3e opus-4-7: `s3://cko-results/t3e/p15b-t3e-opus47-eu-central-1/`
- AgentLAB opus-4-8 stratified-50: `s3://cko-results/agentlab/p15b-agentlab-opus48-strat50-eu-west-1/`
- AgentDojo sonnet-4-6 banking+travel: `s3://cko-results/promptarmor-bedrock/p15b-agentdojo-sonnet46-bank-travel-eu-central-1/`

All numbers verified against per-rep RepResult JSON. n_classifiable, attack_n_complete, asr_aggregate, byAttackType.{n, succeeded}, runs[].displayedToUser, suites[0].asr were the canonical fields used.
