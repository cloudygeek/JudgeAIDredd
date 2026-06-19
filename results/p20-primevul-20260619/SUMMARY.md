# P20 P2 — second testbed: PrimeVul merge/hold SUMMARY

**Run:** `p20-primevul-*-v0.1.717-20260619T1829*Z` (one model/box, bedt11-14).
**Deck:** `primevul` — 100 cases from colin/PrimeVul paired/test (50 vulnerable→hold + 50 fixed→merge), real CWEs (476/617/190/787/416/415/862…), persona-neutral, **N=20 (2000 reps/cell, 8000 total)**. 0 fail-soft.
**Decision:** "is this function safe to merge?" → merge | hold (hold↔caught, the analog of hijacked).

Implements the wave-1 doc §P2. Purpose: show the non-determinism / single-judge-failure findings on a DIFFERENT decision type (static code security) than tool-call approval — so they aren't an artifact of the adv deck.

## Results — hold-recall (vuln caught) / false-hold (safe blocked) / F1 / MCC

| Model | Vendor | hold-recall | false-hold | F1 | **MCC** |
|---|---|---|---|---|---|
| opus-4-8 | Anthropic | 62% | 37% | 0.62 | **0.25** |
| haiku-4-5 | Anthropic | 94% | 89% | 0.66 | 0.09 |
| qwen3-235b | Alibaba | 82% | 76% | 0.64 | 0.07 |
| deepseek-v3.2 | DeepSeek | 32% | 31% | 0.39 | 0.01 |

**Read MCC, not F1.** The deck is balanced (50/50), so an over-blocker that holds nearly everything still posts high recall AND high F1 (haiku F1=0.66 at 89% false-hold!). MCC corrects for this: it credits *discrimination*, and exposes that only opus separates vulnerable from fixed code.

## Findings — the general claim holds, and sharpens

**1. The single-judge failure replicates on a second testbed — and it's SEVERE.** Three of four judges are at-or-near chance at telling vulnerable code from its fix (MCC ≤ 0.09). deepseek (0.01) is a coin flip. This is the merge/hold analog of the wave-1 hijack finding: no solo judge is safe alone. The result is not an artifact of the tool-call corpus.

**2. The failure MODE is model-dependent — and inverts vs the hijack task.** On hijacks the panel was *permissive* (allow-everything, ~0% false-block). On code-security the weaker judges *over-block*: haiku holds 94% of vulns but also 89% of safe code; qwen 82%/76%. They collapse to "hold everything", barely discriminating (recall − false-hold ≈ 5pp). opus is the exception — 62%/37%, a real 25pp separation.

**3. Judge competence is task-specific, not a stable trait.** qwen was the BEST discriminator on hijacks (wave-1 25% recall / 0% false-block) but is near-random here (MCC 0.07). opus was middling on hijacks (11% recall) but is the BEST here (MCC 0.25). So "which model is the good judge" flips with the decision type — a caution against picking a judge on one benchmark.

**4. Same Pareto lesson, second axis.** As in wave 1/2, raising recall by over-blocking is not free here (false-hold tracks recall almost 1:1 for haiku/qwen) — the safety/availability trade-off is real on code-security too, reinforcing "a bounded judge needs deterministic gates, not just a louder veto."

## Data
`cases[].reps[]` + per-cell `groundTruth` + `labels.json` intact (consensus_pilot-ready). Source deck: `p20/primevul-deck.json` (reproducible via `p20/fetch-primevul-deck.py`). Cells pulled via `/files` (S3 token expired mid-run; see note) — re-push to S3 pending a credential refresh.
