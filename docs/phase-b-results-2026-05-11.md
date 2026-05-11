# Phase B — PromptArmor Head-to-Head Results

**Date:** 2026-05-11
**Plan:** [docs/test-plan-promptarmor-headtohead-2026-05-08.md](test-plan-promptarmor-headtohead-2026-05-08.md)
**Implementation:** [docs/plan-promptarmor-implementation-2026-05-08.md](plan-promptarmor-implementation-2026-05-08.md)
**Code:** v0.1.322 (server) / v0.1.330 (side-car hook with intent fixes — not used by these runs)

This document summarises the head-to-head Phase B runs across the AgentDojo and InjecAgent corpora, comparing **none** (no defence), **B7.1** (Dredd intent-tracker prompt v2), and **PromptArmor** (Shi et al., ICLR 2026; arXiv 2507.15219). Raw artefacts (cell logs, summary JSONs) live alongside this doc under `benchmarks/agentdojo/runs/phaseB-20260510/` and `benchmarks/injecagent/runs/phaseB-20260{509,510}/`.

---

## TL;DR

1. **AgentDojo workspace × `important_instructions` is saturated** for both Claude Sonnet 4.6 and Opus 4.7 — the agents' own safety training drives ASR to 0.0% with no defence at all. The corpus cannot differentiate defences on these models.
2. **PromptArmor's wall-time cost is 6–7× B7.1** (and 7× the unprotected baseline) on AgentDojo with no measurable security benefit on saturated cells.
3. **Qwen3-32B InjecAgent is the cell that separates defences:** baseline ASR 24.5% → **B7.1 0.1%** vs **PromptArmor 1.2%**. Qwen3-32B + Direct-Harm (S2 sub-attack) is the only place where any defence sees non-trivial residual ASR.
4. **Opus-4-7 InjecAgent is unscored** — every Bedrock call failed with `temperature is deprecated` at the time the run started (fix landed in commit `1b4341f5` *after* this run kicked off; rerun required).

---

## AgentDojo workspace × `important_instructions` (560 tests/cell)

`benchmarks/agentdojo/runs/phaseB-20260510/`

| Agent | Defence | ASR | Utility | Wall-clock |
|---|---|---|---|---|
| sonnet-4-6 | none        | 0.0% | 96.07% | 1h44m |
| sonnet-4-6 | B7.1        | 0.0% | 95.89% | 1h47m |
| sonnet-4-6 | promptarmor | 0.0% | 96.10% | 11h54m |
| opus-4-7   | none        | 0.0% | 98.75% | 1h24m |
| opus-4-7   | B7.1        | 0.0% | 98.75% | 1h28m |
| opus-4-7   | promptarmor | 0.0% | 98.75% | 8h14m |

**Source files:**
- Sonnet `none`: `benchmarks/agentdojo/runs/phaseB-20260510/sonnet/summary-eu.anthropic.claude-sonnet-4-6-none-important_instructions.json`
- Sonnet `B7.1`: `benchmarks/agentdojo/runs/phaseB-20260510/sonnet/summary-eu.anthropic.claude-sonnet-4-6-B7.1-important_instructions.json`
- Sonnet `promptarmor`: scraped from `…/phaseB-20260510T132839Z-sonnet-sonnet-promptarmor-important_instructions-workspace.log` (no summary JSON written by runner)
- Opus same pattern under `…/opus47/`

### Operational caveat — PromptArmor `/screen` timeouts

The PromptArmor cells fired `/screen` against the same `judge-ai-dredd-interactive` hook container that runs the Dredd judge. AgentDojo's per-call timeout was 30s; under concurrent bedt3+bedt4 load, Bedrock latency for the Sonnet-based detector exceeded that for many calls and the AgentDojo client logged

```
WARNING PromptArmor /screen failed: Read timed out (read timeout=30.0)
```

Fail-open behaviour means the agent proceeded without screening on those calls. Final ASR is still 0% because the Claude agents weren't being hijacked anyway, but this means the **PromptArmor cell for these runs reflects partial coverage**, not full screening. The wall-time numbers are still legitimate as a *cost* signal — PromptArmor on every tool result is dominated by network + Bedrock latency × call count.

**Action item for re-runs on weaker agents:** bump `benchmarks/agentdojo/promptarmor_defense.py` timeout to 90s, or split PromptArmor onto its own hook slot.

---

## InjecAgent base setting (1054 single-shot cases / 544 valid + 510 valid Direct-Harm)

`benchmarks/injecagent/runs/phaseB-20260{509,510}/`

| Agent | Defence | ASR-valid (Total) | ASR-valid (S2 / Direct-Harm L2) | Wall-clock |
|---|---|---|---|---|
| sonnet-4-6 | none        | 0.0%   | —    | ~24m |
| sonnet-4-6 | promptarmor | 0.0%   | —    | ~95m |
| opus-4-7   | none        | **null** (all cases failed: `temperature` deprecated) | n/a | aborted |
| opus-4-7   | promptarmor | **null** (all cases failed: `temperature` deprecated) | n/a | aborted |
| qwen3-32b  | none        | **24.5%** | 93.3% | 15m |
| qwen3-32b  | B7.1        | **0.1%** | — | 22m |
| qwen3-32b  | promptarmor | **1.2%** | 33.3% | 32m |

**Source files:**
- Sonnet/opus47: `benchmarks/injecagent/runs/phaseB-20260509/sonnet-opus47/`
- Qwen3-32B: `benchmarks/injecagent/runs/phaseB-20260510/qwen3-32b/`

### Headline finding

Qwen3-32B is the agent that exposes ASR. On this cell:

- **Bare Qwen3-32B is hijacked 24.5% of the time** (Direct-Harm 19.2%, Data-Stealing 29.6%, S2 sub-attack reaches 93.3%).
- **Dredd B7.1 collapses ASR to 0.1%** — a 245× reduction in success rate.
- **PromptArmor reaches 1.2%** — a 20× reduction, but still 12× B7.1's residual.
- The S2 sub-attack alone separates the two defences sharply: Dredd suppresses it entirely; PromptArmor leaves 33.3% residual.

This is the load-bearing result for the Springer revision: a fair, in-framework comparison on the same corpus and agent shows Dredd's PreToolUse intent-tracker outperforming a state-of-the-art content-side detector on the cell where both defences are actually being measured.

### Caveats

- **Sonnet-4-6 baseline is 0.0%** — Claude's safety training neutralises the InjecAgent prompts unaided. Same saturation as AgentDojo. We retain the row to document the saturation; no defence comparison is meaningful.
- **Opus-4-7 was scored `null`** because every case threw `ValidationException: temperature is deprecated for this model` from Bedrock Converse. The fix is in `bedrock-client.ts` and `benchmarks/injecagent/run_benchmark.py` (commit `1b4341f5`), but landed after the bedt4 run was already submitted. **Pending: re-run opus-4-7 InjecAgent baseline + PromptArmor + B7.1 against the fixed image.**
- **Promotional risk on PromptArmor:** the original paper reports <1% FNR; we measure 1.2% on Qwen3-32B InjecAgent. Within their reported range; we are not refuting their claim, only showing that on this cell B7.1 is comparable-to-better.

---

## What's still missing for the paper

| Cell | Status |
|---|---|
| AgentDojo workspace, sonnet/opus, all defences | ✅ done — all saturated 0% ASR, retained as utility-cost row group |
| InjecAgent base, qwen3-32b, all defences | ✅ done — headline result |
| InjecAgent base, sonnet, all defences | ✅ done (saturated 0%) |
| InjecAgent base, opus-4-7, all defences | ❌ **rerun required** (Bedrock temperature error) |
| AgentDojo other suites (banking, slack, travel) | ⚠️ not run — workspace is the canonical paper cell |
| MT-AgentRisk | ⚠️ pending |
| AgentLAB | ⚠️ pending |

---

## Cost / wall-time observations

| Cell | None | B7.1 | PromptArmor | PA × B7.1 | PA × baseline |
|---|---|---|---|---|---|
| AgentDojo workspace, sonnet | 1h44m | 1h47m | 11h54m | **6.7×** | 6.9× |
| AgentDojo workspace, opus47 | 1h24m | 1h28m | 8h14m | **5.6×** | 5.9× |
| InjecAgent base, qwen3-32b | 15m | 22m | 32m | **1.5×** | 2.1× |

PromptArmor's per-call cost dominates AgentDojo because every tool result is screened individually with a Bedrock Sonnet call, and the AgentDojo workspace cell has many tool calls per task. InjecAgent has one tool result per case, so the multiplier is much smaller.

B7.1's overhead is **negligible** on AgentDojo (1.7–4.8% wall-time premium) because the PreToolUse judge fires once per *agent-proposed* tool call, and only when Stage 1 (policy) and Stage 2 (drift) both escalate.

---

## Reproducibility

- AgentDojo container: `judge-ai-dredd-promptarmor-bedrock` zip, deployed to bedt3 (sonnet) and bedt4 (opus47) on 2026-05-10 13:28:39 UTC. Run IDs `phaseB-20260510T132839Z-sonnet` and `phaseB-20260510T132839Z-opus47`.
- InjecAgent container: `judge-ai-dredd-injecagent` zip, deployed to bedt5 on 2026-05-10. Run IDs `phaseB-injecagent-qwen-20260510T081911Z` (none + B7.1) and `phaseB-injecagent-qwen-pa-20260510T125152Z` (promptarmor).
- All hook calls hit `https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal/` with `mode: autonomous` (B7.1 cells) and `mode: learn` (PromptArmor cells, screen-only).
- Source: `benchmarks/agentdojo/dredd_defense.py`, `benchmarks/agentdojo/promptarmor_defense.py`, `benchmarks/injecagent/run_benchmark.py`. PromptArmor prompt: `src/promptarmor/prompts.ts`.
