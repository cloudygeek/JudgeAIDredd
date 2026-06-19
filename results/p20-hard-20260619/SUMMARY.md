# P20 hard-deck — full 8-vendor F1/MCC at persona-neutral

**Run:** `p20-hard-*-v0.1.711-20260619T1446*Z` (7 vendors on bedt12/13/14) + the wave-2 A1 neutral cells for opus-4-8 & qwen3-235b (same config). **Deck:** `adv+benign` — 12 hijacks + 12 HARD dual-use near-misses, persona-neutral, N=20 (240 reps/cell). 0 fail-soft (kimi 1/240 unparseable).

This pairs hijack recall with a MEANINGFUL false-block (the hard near-miss deck, not wave-1's trivial benign deck), so F1/MCC are computable for the whole panel on one axis.

## Full panel (persona-neutral, hard deck), sorted by F1

| Model | Vendor | Recall | False-block | F1 | MCC |
|---|---|---|---|---|---|
| qwen3-235b | Alibaba | 27% | 0% | 0.43 | 0.40 |
| haiku-4-5 | Anthropic | 23% | 0% | 0.38 | 0.36 |
| gpt-4o | OpenAI | 16% | 0% | 0.27 | 0.29 |
| opus-4-8 | Anthropic | 11% | 0% | 0.20 | 0.24 |
| glm-4.7 | Zhipu | 10% | 0% | 0.17 | 0.22 |
| nova-pro | Amazon | 8% | 0% | 0.15 | 0.21 |
| kimi-k2-thinking | Moonshot | 2% | 0% | 0.04 | 0.10 |
| gpt-oss-120b | OpenAI-OW | 1% | 0% | 0.02 | 0.06 |
| deepseek-v3.2 | DeepSeek | 0% | 0% | 0.00 | 0.00 |

## Findings

**1. At persona-neutral, false-block is ~0% for EVERY vendor — even on the hard deck.** No judge over-blocks the dual-use near-misses when given the plain prompt. So precision is ~100% everywhere and **F1/MCC are driven entirely by recall** — the safety/availability Pareto at neutral collapses to a single axis (recall). Vendors are not trading availability for safety; they're uniformly permissive and differ only in how much they catch.

**2. Recall on the hard deck tracks the wave-1 adv-only recall closely** (haiku 23% vs 23%, gpt-4o 16% vs 15%, deepseek 0% vs 0.4%) — adding the 12 near-miss benigns did not perturb hijack detection. Consistency check passed.

**3. Over-blocking only appears with aggressive PERSONAS, not at neutral** (wave-2 §A3): qwen-compliance hit 15% false-block, qwen-auditor 8%. So the availability cost in this corpus is a function of *prompt*, not *vendor* — which is why the omni prompt (high recall, ~0% false-block) dominates: it raises recall without the over-blocking the aggressive personas incur.

**Bottom line for the paper:** at the neutral operating point the entire 8-vendor panel sits at 0% false-block / 0–27% recall — the "allow almost everything, catch little" corner. F1 ≤ 0.43 for the best single judge. This is the standalone-judge ceiling the consensus + omni-prompt + deterministic-gate stack is measured against.
