# p15b — runs still in flight (2026-06-08 16:40 BST)

Snapshot of the container fleet at the tail end of the T5 Sonnet-judge
campaign. **22 T5 Sonnet models + the full T3e Sonnet set are committed and
pushed** (origin `harness/agentlab-restore-and-fr4-adapters`). What remains is
4 running cells: 2 normal-speed tails and 2 deliberately-slow outliers the
operator chose to let finish rather than kill.

## Still running

| Container | Model | Test / judge | Region | Progress | Rate | ETA | Why slow |
|---|---|---|---|--:|--:|--:|---|
| **bedt16** | claude-haiku-4-5 | T5 / Sonnet | eu-central-1 | 96/120 | 0.16/min | **~2.5h** | verbose multi-turn migration scenarios; healthy, progressing |
| **bedt9** | glm-4.7-flash | T5 / Sonnet | us-west-2 | 45/120 | 0.12/min | **~10h** | rate decayed over the run; valid data, INTENT verdicts firing |
| **bedt3** | deepseek-v3.2 | T5 / Sonnet | us-west-2 | 47/120 | 0.04/min | **~29h** | large coding model, extensive Edit/Write/Bash tool loops per rep (~16–25 min/rep). Genuine model verbosity, not a bug — canaries fire, scoring works. **Left running by operator decision.** |
| **bedt14** | qwen3-coder-480b | T3e / `none` baseline (v0.1.549) | us-west-2 | 37/80 | 0.02/min | **~31h** | the unique T3e baseline cell for qwen-480b; same coding-model verbosity. `none` arm (judge-independent), so the older v0.1.549 image is fine. **Left running by operator decision.** |

(Rates/ETAs are point-in-time from the live `/status` progress counters; the two
slow outliers drift as their per-rep tool-loop length varies.)

## What each will add when it lands

- **haiku-4-5 T5 (bedt16)** — completes the Anthropic T5 row alongside the
  already-committed opus-4-5 / opus-4-6 / opus-4-8-defonly / sonnet-4-6.
- **glm-4.7-flash T5 (bedt9)** — the GLM-flash exfiltrator cell for T5 (its T3e
  counterpart already shows the exfiltrator profile, base 71% network exfil).
- **deepseek-v3.2 T5 (bedt3)** — the top T3e exfiltrator (65% base); its T5 cell
  closes the deepseek pair (v3.1 T5 already committed at base 55/37 → def 28/23).
- **qwen3-coder-480b T3e baseline (bedt14)** — the `none` arm to pair with the
  already-run intent-tracker arm; needed for the qwen-480b T3e base-vs-def delta.

## After these land

The T5 Sonnet set is complete bar nothing, and the consolidated **T5 Sonnet
both-field summary doc** (`exfiltrationDetected` + `displayedToUser`, three-way
tier split mirroring `docs/p15b-t3e-sonnet-summary-2026-06-07.md`) gets written.

## Idle containers

bedt4, bedt5, bedt6, bedt7, bedt8, bedt10, bedt11, bedt12, bedt13, bedt15,
bedt17 — all idle, results pulled + committed + pushed. No launches queued; the
campaign is winding down to the 4 tails above.
