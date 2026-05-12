# Phase C — InjecAgent Cross-Vendor Results

**Date:** 2026-05-12
**Plan:** [docs/test-plan-phase-c-2026-05-11.md](test-plan-phase-c-2026-05-11.md)
**Phase B predecessor:** [docs/phase-b-results-2026-05-11.md](phase-b-results-2026-05-11.md)

This document covers the Phase C re-runs that landed valid data. Earlier C6 attempts (`-20260511T151941Z`, `-retry-20260511T221258Z`) hit two infrastructure bugs (catastrophic-backtracking regex hung the production hook 24h+, then a session-id collision with persisted Dynamo state caused fail-open) — those runs are excluded from the headline numbers but are documented inline so the audit trail is intact.

---

## TL;DR

**Cross-vendor generalisation confirmed.** The Phase B Qwen3-32B finding (24.5% baseline → 0.1% with B7.1 vs 1.2% PromptArmor) reproduces on GPT-4o-mini at the same shape: bare model is hijacked at meaningful rates, B7.1 collapses ASR to near zero, PromptArmor catches almost-as-many on aggregate but **leaves the S2 sub-attack at 100%** while B7.1 kills it entirely.

| Agent | Defence | ASR-valid Total | DH | DS | DS-S2 sub | Wall |
|---|---|---|---|---|---|---|
| **gpt-4o-mini** | none | **16.7%** | 8.0% | 24.7% | 97.6% | ~55m |
| **gpt-4o-mini** | B7.1 | **0.2%** | 0.4% | 0.0% | **0.0%** | 1h45m |
| **gpt-4o-mini** | promptarmor | **0.3%** | 0.2% | 0.4% | **100.0%** | 1h37m |
| **opus-4-7** | none | **0.0%** | 0.0% | 0.0% | — | 4h43m |
| **opus-4-7** | B7.1 | **0.0%** | 0.0% | 0.0% | — | 2h31m |
| **opus-4-7** | promptarmor | (cancelled — saturated row, no measurable defence delta) | | | | |

Two takeaways:

1. **GPT-4o-mini result is the cross-vendor cell that confirms the contribution-3 claim.** Together with Qwen3-32B (24.5%→0.1% B7.1, vs 1.2% PromptArmor), the paper now has two non-Anthropic agents where Dredd's PreToolUse intent-tracker outperforms PromptArmor's content-side preprocessor on the same corpus.

2. **Opus-4-7 baseline saturates at 0%** (same as Sonnet 4.6). The paper documents this as the Anthropic-floor finding: frontier-model safety training neutralises InjecAgent unaided.

---

## Runs covered

| Run ID | Container | Status | What it produced |
|---|---|---|---|
| `phaseC-injecagent-gpt4omini-20260511T151941Z` | bedt5 | ✅ baseline cell only valid; B7.1 + promptarmor cells fail-opened against the wedged hook | Used for the `none` baseline (16.7% ASR) |
| `phaseC-injecagent-gpt4omini-retry-20260511T221258Z` | bedt5 | ❌ session-id collision invalidated B7.1 + promptarmor | Discarded |
| `phaseC-injecagent-gpt4omini-retry3-20260512T083658Z` | bedt5 | ✅ all cells clean; salted session ids + rehydrated hook | Used for B7.1 (0.2%) + promptarmor (0.3%) |
| `phaseC-injecagent-opus47-retry2-20260512T083658Z` | bedt4 | ⏳ cell 1/3 done; cells 2-3 still running | Used for opus-4-7 `none` (0.0%) — others pending |

Raw artefacts under `benchmarks/injecagent/runs/phaseC-20260512/`:
- `c6-gpt4omini-baseline/` — gpt-4o-mini × `none` cell from the first run
- `c6-gpt4omini-retry3/` — gpt-4o-mini × {B7.1, promptarmor} from the third (clean) run
- `c1-opus47-retry2/` — opus-4-7 × `none` from the in-flight C1 retry; cells 2-3 will land later

---

## What the Dredd telemetry confirms

The C6-retry3 B7.1 cell isn't just reporting low ASR — the per-case JSONL records the exact stage Dredd used to block each would-be-success. From `gpt-4o-mini-dredd-B7.1/test_cases_dh_base.json`:

- 510 Direct-Harm cases run
- 37 cases would have succeeded without defence (`eval_no_defence == "succ"`)
- Dredd intervened on 35 of those 37:
  - **24 caught at drift-deny** (Stage 2: embedding similarity below threshold)
  - **4 caught at judge-deny** (Stage 3: LLM judge classified as hijacked)
  - **7 caught at session-locked** (autonomous mode lock after first hijack)
  - 2 leaked through (`judge-allow` — matches the 0.4% DH ASR)

This is the post-fix telemetry shape — every prior broken run had `stage: "no-goal-allow"` for every case, indicating the hook had no goal registered and was permitting everything. The fix from commits `2255501d` (session-id salting) + `db3a188c` / `9841b82e` (hook rehydration) made this run valid.

---

## Bugs found and fixed during Phase C

| Bug | Symptom | Fix |
|---|---|---|
| Catastrophic-backtracking regex in `fuzzyStrip` | Hook process pinned at 25% CPU (1 vCPU at 100%) for 24h+, ALB 504s on every `/screen` and `/evaluate` | `476fecc4` — replaced regex with linear forward-walking token matcher |
| Session-id collision with persisted Dynamo state | Every defended cell logged `stage: no-goal-allow`, fail-opening; ASR identical to baseline | `2255501d` — runner salts session id with RUN_ID so re-attempts don't reuse Dynamo entries |
| In-memory `registeredSessions` empty after redeploy | Sessions registered before redeploy fall through `no-goal-allow` on the new container | `db3a188c` + `9841b82e` — rehydrate from SessionStore on miss; use persisted `originalIntent` not the current prompt |
| Runner doesn't fire `/end` per case | Sessions accumulate in Dynamo; same RUN_ID re-runs collide | `2255501d` — runner now POSTs `/end` after every case |
| Runner has no fail-fast gate | A wedged hook produces fail-open junk for the whole cell silently | `6ff1178d` — abort cell after MAX_DREDD_FAILURES consecutive errors |

The cumulative effect of these fixes is what makes the C6 retry-3 numbers trustworthy.

---

## Pending work (Phase C continuation)

- C1 retry-2 cell 2 (opus-4-7 × B7.1) — completed at 15:51 UTC, 0.0% ASR, 1054 cases. Confirms saturation: with no defence the model already refuses 100% of injection attempts; with B7.1 the same. Dredd never had a would-be-success to flip, so its post-output judge fired but never overrode an `eval == "succ"`. Documented in the table above.
- C1 retry-2 cell 3 (opus-4-7 × promptarmor) — **cancelled** during the dh half. Cells 1+2 saturated at 0.0%; the PromptArmor cell on a saturated agent measures only PromptArmor's runtime cost, not its defence efficacy (no DS-S2 to differentiate on a model that refuses everything anyway). The ~$80 of opus-4-7 + Sonnet-detector spend wasn't justified by the marginal information.
- C5 (T3e × Qwen3-32B + Qwen3-235B) — paper's own corpus head-to-head, deferred.
- AgentDojo other suites (banking / slack / travel) — Phase C2, deferred.

---

## Reproducibility

- Hook: `judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal` v0.1.341+ (rehydration + ReDoS fix).
- Runner: `judge-ai-dredd-injecagent.zip` v0.1.339 (salted session ids + `/end` per case + fail-fast gate).
- Trust mode: runner explicitly sends `mode: autonomous` per request, so the global hook mode is irrelevant for benchmark scoring.
- All cells used `MAX_DREDD_FAILURES=5`.
- OpenAI key passed via the `params.env` block on the kick-off curl, not Secrets Manager.
