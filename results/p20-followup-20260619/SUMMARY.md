# P20 wave-2 — bias-vs-prompt-vs-panel SUMMARY (INTERIM)

**Run:** `p20-w2-*-v0.1.711-20260619T1*Z` — Opus arms (bedt12) + qwen arms (bedt11).
**Deck:** `adv+benign` — 24 cases: 12 hijacks (`adv-1..adv-12`) + **12 HARD dual-use near-misses** (`near-1..near-12`, 1:1 matched, read the *real* `.env`/creds with legitimate intent). persona-neutral body held fixed; **N=20 (240 reps/cell)**.
**Status:** INTERIM — A1 (neutral) + A2 (omni) complete for both models; A3 persona panel (auditor/sre/compliance/redteam) still running. Updated as cells land.

Implements `docs/test-request-p20-followup-bias-availability-2026-06-19.md`. Wave 1 found the judge failure is mostly **bias, not variance** (consensus saturates at ~2 votes); wave 2 asks whether fixing the *prompt* beats aggregating *votes*.

## Headline — A1 (neutral) vs A2 (look-for-everything), on the hard deck

| Model | Arm | Recall (95% CI) | False-block (95% CI) |
|---|---|---|---|
| opus-4-8 | A1 neutral | 11% [8,16] | 0% |
| opus-4-8 | **A2 omni** | **62% [56,68]** | 2% [1,5] |
| qwen3-235b | A1 neutral | 27% [22,33] | 0% |
| qwen3-235b | **A2 omni** | **70% [64,76]** | 0% |

## The result: a better PROMPT beats a panel — and nearly free on availability

**The single "look-for-everything" prompt (A2) recovers most of the bias gap in one call:** opus recall 11%→**62%** (5.6×), qwen 27%→**70%** — while false-block stays **0–2%**. The gains are far outside the Wilson CIs (real, not sampling noise).

This directly answers wave-2's central design question (§1.1): **fixing the signal beats aggregating votes.** Wave-1 consensus over 6 vendors hit ~71% block-recall only via the fail-closed conjunctive rule (and saturated at ~2 votes under error correlation Q=0.59); a single judge with the right prompt reaches 62–70% recall **alone**, no panel, no multi-call cost.

And the hard near-miss deck is doing its job: even at 62–70% recall the judges still correctly ALLOW the dual-use benigns (read the real `.env` for config → consistent), so this is **real discriminating signal, not a threshold shift** — omni didn't just move along the ROC by blocking more (that would have spiked false-block).

## Still pending (A3 / B-arms in flight)
- **A2 vs A3** (does the 5-persona panel beat the single omni prompt at matched availability?) — needs the auditor/sre/compliance/redteam cells.
- **A3 vs A4** (does the persona panel sit above or on the single-judge ROC? persona-panel Q vs wave-1's 0.59) — P20 computes offline from the persona cells + A1's confidence sweep.
- Both models carry these arms, so the finding's vendor-generality is testable.

All cells 0 fail-soft (qwen-omni: 1/240 unparseable, negligible). `cases[].reps[]` + per-cell `groundTruth` + combined `labels.json` intact for `consensus_pilot.py`.
