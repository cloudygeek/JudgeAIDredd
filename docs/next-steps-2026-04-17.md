# Next Steps — 2026-04-17

**Context:** Follow-up to `docs/opus-4-7-test-update.md` (2026-04-16 plan). First round of Opus 4.7 / effort-sweep runs have landed. Several suites are infrastructure-broken and several findings already invalidate parts of the original plan.

## What ran (2026-04-16 → 2026-04-17)

| Suite | Location | Status |
|---|---|---|
| Test 1 — Pipeline E2E, configs A/B/C/D/E/F/G/H × {none, low, medium, high, max} (+xhigh for E) | `results/pipeline-e2e-*.json`, `results/test1/` | ✅ usable |
| Test 8 — Adversarial judge × 8 models × {none, low, medium, high, max} | `results/test8/` | ⚠️ partial — see below |
| Test 3a — Bimodality robustness (Opus 4.7, default + high) | `results/test3a/20260416T212525Z/` | ❌ all 1,620 runs API-errored |
| Test 9a — Latency (Sonnet 4.6 medium/high, Opus 4.7 default/high) | `results/test9a/` | ⚠️ Sonnet usable, Opus all errored |

## Findings that change the plan

### 1. Effort does not improve adversarial catch rate

Clean 2026-04-17 re-runs for the Anthropic judges:

| Model | none | medium | high | max |
|---|---|---|---|---|
| Claude Sonnet 4.6 | 6/12 | 5/12 | 3/12 | 5/12 |
| Claude Haiku 4.5 | 1/12 | 1/12 | 2/12 | 0/12 |

Movement is within noise. The `opus-4-7-test-update.md` early-stop rule ("downgrade to `none` + `high` if catch-rate moves <10% between `none` and `high` for all models") triggers. Drop the five-level sweep from Tests 1, 7 before more compute is burned. The "effort is a cheaper lever than model-tier upgrade" hypothesis is not supported by the available data.

### 2. Opus 4.7 does not beat Haiku 4.5 as judge (Test 1)

Pipeline accuracy on 29 labelled cases, across all effort levels including `xhigh`:

| Config | Embedding | Judge | Accuracy range |
|---|---|---|---|
| C | nomic-embed-text | Claude Haiku 4.5 | **97%** (flat across efforts) |
| E | nomic-embed-text | Claude Opus 4.7 | 93% (flat, incl. xhigh) |
| F | Cohere Embed v4 | Claude Opus 4.7 | 93–97% (max best) |
| G | nomic-embed-text | Claude Sonnet 4.6 | 93–97% (medium best) |
| H | Cohere Embed v4 | Claude Sonnet 4.6 | 90–93% |

Haiku 4.5 remains the recommended judge. Config C's single FN (`edge-1`) is the universal mis-labelled case already noted in `p15.tex`; Opus 4.7 inherits the same FN and adds a second one. Paper's judge leaderboard ordering stands.

### 3. Clean baseline adversarial numbers differ from the paper

Clean `none`-effort runs on 2026-04-16:

- Sonnet 4.6: **6/12** (`p15.tex` reports 7/12 in `tab:adversarial`)
- Nova Micro: **1/12** (`p15.tex` reports 2/12)

Either the paper is stale or the new clean runs drifted by one case. Worth a one-case diff on the adversarial set before patching the paper — this is two cases out of ~60 possible catches, so it could be stochastic judge variation rather than a test-set change.

## What's broken

### Opus 4.7 Bedrock API — two separate bugs

**Test 8 (judge path):** All Opus 4.7 adversarial runs fail with:
```
ValidationException: "thinking.type.enabled" is not supported for this model.
Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
```

Commit `b039c1a` ("Use adaptive thinking API for Opus 4.7") addressed this for the Test 1 judge path but the same fix has not propagated to whichever Bedrock call the Test 8 adversarial runner uses on 2026-04-17. Every `Claude Opus 4.7` row in `results/test8/` (both 04-16 and 04-17) is fail-open contaminated — 0/12 caught, `"Judge error (fail-open)"` in every case reasoning field.

**Tests 3a + 9a (agent-SDK path):** All Opus 4.7 agent runs fail on turn 0 with:
```
API Error: 400 { "error": { "type": "invalid_request_error", "message": "invalid beta flag" } }
```

This is the Claude Agent SDK invocation, not the direct Bedrock Converse call. Separate code path, separate fix. 1,620 Test 3a runs + 240 Test 9a runs are unusable — hijack rates report 0% only because the agent never issued a tool call, and GES=100 is spurious.

## Action items

Ordered by blast radius. Items 1–2 must land before any further Opus 4.7 compute is spent.

1. **Fix Opus 4.7 adaptive-thinking call in the Test 8 judge invocation.** Locate the Bedrock Converse call used by the adversarial runner and apply the same adaptive-thinking shape as commit `b039c1a`. Verify with a single-case dry run before re-running the suite.

2. **Fix "invalid beta flag" on the Opus 4.7 Agent SDK path.** Root-cause in the SDK client setup (likely a `anthropic-beta` header appropriate for 4.6 but not 4.7, or a request-field `thinking.type.enabled` mirrored from the direct Bedrock path). A clean single-turn smoke test on Opus 4.7 is enough to validate.

3. **Re-run only the Opus 4.7 rows:**
   - Test 8 adversarial × Opus 4.7 × {`none`, `high`} (24 cases, trivial cost).
   - Test 3a bimodality × Opus 4.7 × {`default`, `high`} (originally 1,620; if early results show the same pattern as Sonnet, don't complete the full sweep).
   - Test 9a latency × Opus 4.7 × {`default`, `high`} (~240 runs).

4. **Downgrade the effort sweep to `none` + `high` for remaining Tests 1 and 7 re-runs.** The adversarial data has already answered "does effort matter for judging adversarials" with no. Don't collect data that won't change the story.

5. **Complete Test 9a Sonnet baselines.** Current data has only medium and high; add `none` to let the paper report a clean baseline latency.

6. **Decide on paper diff for `tab:adversarial` (Sonnet 6→7, Nova Micro 1→2).** Either:
   - Re-run 5 reps on each to check whether 7/12 is a spurious high and 6/12 is the real rate, or
   - Accept the new run as the canonical number and patch `Adrian/p15/p15.tex:415`.

## Effort budget implied

- Fixes (1–2): ½ day engineering.
- Re-runs (3): Test 8 Opus ~15 min, Test 9a Opus ~2 h, Test 3a Opus **only if effort matters** (see item 4) — otherwise run just `none` and `high` at 20 reps, not 90, as a confirmation.
- Outstanding per original plan: Test 7 × Opus 4.7 baseline + defended, now 2 effort levels instead of 3 — still the load-bearing run, ~8–12 h.

Total: ~1–1½ days once fixes land, down from the ~2 days implied by the original three-level plan.
