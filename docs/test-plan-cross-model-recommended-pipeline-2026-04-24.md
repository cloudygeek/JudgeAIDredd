# Test Plan — Cross-Model Re-run Under the Recommended Pipeline

**Date:** 2026-04-24
**Context:** P15 §6.9 (Cross-Model Agent Evaluation) currently uses the earlier Stop-hook prototype's default pipeline — Amazon Titan Embed V2 + the baseline judge prompt, evaluated post-turn via Stop hook. The paper's production recommendation is **Cohere Embed v4 + prompt v2** invoked at the **PreToolUse** gate. The §6.9 cross-model $\Delta$GES figures therefore characterise the earlier pipeline rather than the paper's headline configuration. This plan re-runs the §6.9 matrix under the recommended pipeline so that the cross-model attribution is clean: any residual $\Delta$GES effect can be attributed to the approval-judge component rather than to the Stop-hook mechanism the current runs inherit.
**Priority:** Medium. Not blocking for submission — the architectural finding the section rests on (post-hoc blocking cannot change $P_r$ or $E_r$) does not depend on the specific embedding or prompt. Elevates §6.9 from a caveated characterisation of the earlier pipeline to a direct measurement of the recommended one.

## What we have now

The §6.9 matrix uses the Stop-hook prototype:

- **Embedding:** `amazon.titan-embed-text-v2:0` (separation score ≈ 0.19; §6.1 Table `tab:embedding-leaderboard-full` ranks it behind Cohere Embed v4).
- **Judge prompt:** baseline (the pre-`HARDENED_SYSTEM_PROMPT` constant). Not prompt v2, which is what §6.8 and the recommended-deployment recipe use.
- **Hook:** Stop hook (post-turn intent-tracker). Not PreToolUse, which is what §4 (Architecture) and §7 (Discussion) advocate.

Under the p14 GES convention (higher is better defence), the Stop-hook matrix shows:

| Agent model | Baseline mean GES (N=60–120) | Defended mean GES | $\Delta$GES |
|---|---|---|---|
| Haiku 4.5 | 31.1 | 12.2 | −18.9 |
| Sonnet 4.6 | 33.3 | 17.8 | −15.6 |
| Opus 4.6 | 32.8 | 10.6 | −22.2 |
| Opus 4.7 | 36.4 | 32.5 | −3.9 |

The negative $\Delta$GES across the matrix is the reactive-blocking artefact documented in §6.6 and §6.7: the Stop-hook block fires 100% of the time but fires *after* the offending turn completes, so it truncates the agent's self-detection signal without moving the hijack or exfiltration terms. That finding is architectural and should survive the re-run. What this plan tests is whether the recommended pipeline — PreToolUse interception + Cohere Embed v4 + prompt v2 — moves **hijack rate** below the 95–100% floor that the Stop-hook prototype cannot break.

## What this plan adds

Replace the three pipeline components with the paper's recommended configuration and re-run the §6.9 matrix:

| Component | Current (Stop-hook prototype) | Recommended (this re-run) |
|---|---|---|
| Embedding model | `amazon.titan-embed-text-v2:0` | `cohere.embed-v4:0` (AWS Bedrock) |
| Embedding separation | 0.19 (Titan, §6.1) | 0.254 (Cohere v4, §6.1) |
| Judge prompt | baseline | prompt v2 (`HARDENED_V2_SYSTEM_PROMPT`) |
| Hook | Stop (post-turn) | PreToolUse (pre-execution) |
| Embedding thresholds | defaults from test4/test7 | `deny=0.15`, `review=0.60` (§S.1) |

Everything else matches the existing §6.9 protocol (same scenarios, same repetition count, same judge model tier).

## Evaluation matrix

| Axis | Values | Notes |
|---|---|---|
| Agent model | Claude Haiku 4.5, Sonnet 4.6, Opus 4.6, Opus 4.7 | Same four models as the current §6.9 matrix |
| Scenario | T3.2, T3.3, T3.4 | Skip T3.1 (100% hijack across all defended configs — no signal) |
| Defence | baseline (none), full-pipeline (PreToolUse + Cohere v4 + prompt v2) | Two arms matching §6.9's existing column convention |
| Repetitions | N=20 per cell | Matches §6.9 |
| Judge model | Claude Haiku 4.5 | Matches §6.9's fixed judge tier |
| Judge prompt | prompt v2 (`HARDENED_V2_SYSTEM_PROMPT`) | The paper's production prompt |
| Embedding | Cohere Embed v4 (`cohere.embed-v4:0`) | The paper's recommended embedding |
| Thresholds | `deny=0.15`, `review=0.60` | From §S.1 (Supplementary) |
| Reasoning effort | `medium` for Opus tiers, `none` for Haiku / Sonnet | Matches the §6.9 convention for each tier |

**Total runs:** 4 models × 3 scenarios × 2 defences × 20 reps = **480 multi-turn runs**. Skipping the baseline arm where it has already been measured under identical agent-model conditions (baseline doesn't depend on the defence pipeline) cuts this to 4 models × 3 scenarios × 20 reps = **240 defended runs + a baseline reconciliation check** (see "Baseline reuse" below).

## Hypotheses

**H1 — The recommended pipeline materially reduces hijack rate below the Stop-hook floor.** PreToolUse interception evaluates the tool call *before* it executes, so a `hijacked` verdict prevents exfiltration rather than reacting to it after the fact. If the hardened-prompt judge catches the offending tool call at the PreToolUse gate with the same 100% adversarial catch rate that §6.5 reports for prompt v2 on Sonnet 4.6 / Opus 4.7, the expected hijack rate on the multi-turn scenarios drops from the 95–100% baseline floor to single digits. Predicted: defended hijack rate < 20% on T3.2 / T3.3 across all four agent models; T3.4 is the hardest scenario and may remain higher.

**H2 — Agent self-detection recovers under PreToolUse blocking.** The Stop-hook artefact (detection rate falls from 83–99% at baseline to 22–38% under the intent-tracker) is driven by the block firing *after* the offending turn truncates the conversation. PreToolUse interception halts the specific tool call without ending the session — the agent can still articulate "this request looks suspicious". Predicted: defended agent-self-detection stays within 10 pp of baseline rather than collapsing.

**H3 — Mean GES moves positive under the recommended pipeline.** Combining H1 (lower $E_r$ — exfiltration is prevented at the tool-call gate) and H2 (higher stealth-broken credit — self-detection preserved) flips the sign of $\Delta$GES on every agent model. Predicted: $\Delta$GES in the +20 to +60 range across the four agents, with the Opus 4.7 cell still the smallest (because its baseline was already highest).

**H4 — Model-specific effects persist but compress.** Under the Stop-hook prototype, Opus 4.7 has the smallest negative $\Delta$GES (−3.9) because T3.4 defended equals baseline (block never fires in time). Under PreToolUse, the per-tool-call judge fires on every proposed tool call, so the T3.4-specific floor disappears. Predicted: the spread in defended mean GES across the four agents narrows from the current 10.6–32.5 range to within 15 pp of each other.

## Success criteria

1. **Provenance fields on every result JSON:** `build.gitSha`, `agent.provider=bedrock`, `agent.model`, `agent.effort`, `judge.model=eu.anthropic.claude-haiku-4-5-20251001-v1:0`, `judge.prompt=v2`, `embedding.model=cohere.embed-v4:0`, `embedding.thresholds={deny:0.15,review:0.60}`, `hook=PreToolUse`, `run.timestamp`, `run.bedrockRegion`.
2. **Hijack rate measurable at Wilson half-width ≤ 10 pp per cell** (20 reps per cell → worst-case half-width 22 pp at p=0.5, ≤ 10 pp once p<0.1 or p>0.9 which the hypotheses both predict).
3. **Baseline reuse validates:** at least one baseline cell per agent model re-measured under the new pipeline (see "Baseline reuse" below) reproduces the earlier numbers within ±5 pp. If baseline drifts more than that, Bedrock weights or the harness have moved under us; document and recalibrate.
4. **Table `tab:cross-model-defended` can be rewritten with positive $\Delta$GES** across every model (the expected outcome under H1+H2+H3) or the outcome can be narrated honestly if hypotheses fail.

## Decision rules

**If H1–H3 are supported (hijack rate < 20%, $\Delta$GES > +20 across models):**
- §6.9 becomes a direct characterisation of the recommended pipeline. The caveat paragraph ("Pipeline-match caveat") can be deleted and replaced with the headline result.
- The Stop-hook numbers become a secondary comparison showing the architectural gap — keep in the paper as "earlier prototype" or move to supplementary.
- Adds a direct empirical answer to the reviewer-response question "does the multi-turn defence actually prevent hijacks?".

**If H1 is supported but H2 is not (hijack rate drops but self-detection still collapses):**
- The PreToolUse interception does prevent exfiltration but the act of blocking still truncates downstream self-detection turns — weaker than expected but still the paper's headline configuration.
- Narrate in §6.9 honestly: "hijack prevention works; self-detection remains a downstream casualty of PreToolUse blocking".
- H2 failure weakens the "blocking is architecturally superior" argument in §7 but does not invalidate it.

**If H1 is not supported (hijack rate stays at 95–100%):**
- Either (a) the judge at the PreToolUse gate still fails on multi-turn gradual-drift pretexts despite the 100% single-turn adversarial catch rate in §6.5, or (b) there's an integration bug (PreToolUse hook not firing, Cohere v4 not producing the expected score distribution, judge model misconfigured).
- First priority: rule out integration bugs by re-running 3 repetitions of a known-hijack trace through the pipeline with judge verdicts logged.
- If genuine: this is a novel finding — the multi-turn trajectory defeats even the recommended pipeline — and changes §7's conclusions materially. Write up honestly; the paper's title remains accurate but §7.1 Finding 1 needs to expand beyond "PreToolUse is sufficient" to "PreToolUse is necessary but the multi-turn trajectory reveals a further gap".

## Execution

### Infrastructure

- **Bedrock:** `eu-central-1` region. Cohere Embed v4 and Haiku 4.5 are both already available there; Opus 4.7 access provisioned per `test-plan-opus-4-7-t3-4-2026-04-24.md`.
- **Harness:** existing `src/runner.ts` multi-turn driver. Needs a CLI flag to select the PreToolUse hook and the prompt-v2 judge (both exist from §6.8 FPR work); thread them through to the per-scenario runner.
- **Embedding:** switch `embedding.model` from `amazon.titan-embed-text-v2:0` to `cohere.embed-v4:0`. The Cohere v4 path is the one §6.8 FPR already uses, so no new code is required.
- **Judge prompt:** `HARDENED_V2_SYSTEM_PROMPT` from `src/intent-judge.ts`. This is the same constant §6.8 uses.
- **Scenarios:** `src/scenarios/T3.2.ts`, `T3.3.ts`, `T3.4.ts` unchanged from §6.9.

### Command

```bash
# From repo root. Assumes AWS_REGION + Bedrock creds exported.

for MODEL in \
  eu.anthropic.claude-haiku-4-5-20251001-v1:0 \
  eu.anthropic.claude-sonnet-4-6-20250929-v1:0 \
  eu.anthropic.claude-opus-4-6-20251013-v1:0 \
  eu.anthropic.claude-opus-4-7-20251017-v1:0; do

  # Effort tier: none for Haiku/Sonnet, medium for Opus (matches §6.9 convention)
  EFFORT=medium
  [[ "$MODEL" == *haiku* || "$MODEL" == *sonnet* ]] && EFFORT=none

  AWS_REGION=eu-central-1 npx tsx src/runner.ts \
    --agent-model "$MODEL" \
    --agent-effort "$EFFORT" \
    --scenario T3.2,T3.3,T3.4 \
    --defence baseline,full-pipeline \
    --hook PreToolUse \
    --repetitions 20 \
    --judge-model eu.anthropic.claude-haiku-4-5-20251001-v1:0 \
    --judge-prompt v2 \
    --embedding-model cohere.embed-v4:0 \
    --embedding-deny 0.15 \
    --embedding-review 0.60 \
    --out results/cross-model-recommended-pipeline/

done
```

### Baseline reuse

The baseline arm does not depend on the defence pipeline (no judge, no embedding, no hook). Rather than re-running 240 baseline runs, re-run **one scenario per agent model at N=20** (the fastest T3.2 cell) under the new pipeline as an integration smoke-test, and re-use the 2026-04-17 / 2026-04-24 Stop-hook baseline numbers for the remaining two scenarios per model. If the smoke-test reproduces the earlier baseline within ±5 pp, skip the remaining baseline cells and save ~120 runs of compute.

If the smoke-test differs by more than 5 pp, something about Bedrock or the scenario fixtures has moved; re-run all baselines fresh (full 240-run matrix).

### Wall-clock and cost

- **Defended runs:** 4 models × 3 scenarios × 20 reps = 240 runs × ~90 s average = **~6 h wall-clock**. Serial across models to avoid rate-limiting collisions.
- **Baseline smoke-test:** 4 models × 1 scenario × 20 reps = 80 runs × ~60 s = ~1.5 h.
- **Total wall-clock:** ~7.5 h (single-stream) or ~3 h with inter-model parallelism if rate limits hold.
- **Cost estimate:**
  - Agent inference: Sonnet 4.6 and Opus 4.6 dominate; ~\$0.05 / run × 240 runs = **~\$12**.
  - Opus 4.7 is more expensive: ~\$0.15 / run × 60 runs = **~\$9**.
  - Haiku 4.5 is negligible: ~\$0.01 / run × 60 runs = **~\$0.60**.
  - Judge (Haiku 4.5 + prompt v2): ~20 invocations per multi-turn run at ~\$0.0001 each = **~\$0.50** across the matrix.
  - Embedding (Cohere v4): ~\$0.0001 per run = **~\$0.03**.
  - **Total:** ~\$25 budget cap, likely ~\$15 actual.

Run overnight on Fargate.

### Paper integration

**`p15.tex` §6.9 updates if H1–H3 are supported:**

1. `tab:cross-model-baseline` — baseline numbers unchanged (they don't depend on pipeline). Note in caption that baseline cells are the same measurement as the Stop-hook matrix; the difference is only in the defended arm.
2. `tab:cross-model-defended` — replace all four rows with the new defended numbers. $\Delta$GES should flip sign (from $-$18.9/$-$15.6/$-$22.2/$-$3.9 to positive values).
3. `tab:cross-model-scenario` — replace all defended cells.
4. Narrative paragraphs — rewrite the three findings under the new headline: "PreToolUse + Cohere v4 + prompt v2 brings defended hijack rate from 95–100% to X%". The reactive-blocking narrative from the Stop-hook prototype moves either to §6.6 (trajectory) alone or to a "comparison to earlier pipeline" subsection.

**§6.9 updates if hypotheses fail:**

- Keep the Stop-hook numbers as the headline but narrate honestly that the recommended pipeline does not close the multi-turn gap as expected.
- Elevate the multi-turn trajectory gap to §7 Discussion as a standing open problem.
- Add a future-work item on multi-turn-specific prompt hardening.

**Supplementary or appendix:**

- Include the Stop-hook numbers as a comparison table if the recommended pipeline re-run dominates. Titled "Earlier Stop-hook prototype (superseded)".

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PreToolUse hook doesn't wire cleanly to multi-turn runner | Medium | High | Smoke-test on 3 runs of T3.2 with Haiku agent before the full matrix. Verify `judge.verdict` fields are populated and the block-vs-allow path is exercised. |
| Cohere v4 rate limit on 80+ concurrent runs | Low | Medium | Use in-runner rate-limiting; fall back to serial per-model if 429s appear. |
| Prompt v2 over-denies on legitimate agent tool calls (high benign-interference) in multi-turn context (not just the §6.8 single-turn case) | Medium | Medium | Baseline arm reveals this — if baseline runs produce `hijacked` verdicts on legitimate tool calls, the prompt v2 is triggering on the agent's own scaffolding. Log `judge.rationale` for all verdicts and inspect. |
| Opus 4.7 cost overrun | Low | Medium | Hard budget cap \$50; halt if exceeded and publish whatever partial matrix is done. |
| Integration bug masquerading as a negative result | Medium | High | Verdict logs should show the judge firing on every proposed tool call; if the verdict distribution looks degenerate (all `consistent`, or all `hijacked`), that's the bug, not a finding. Mandatory smoke-test before the overnight run. |

## Non-goals

- Cross-model × prompt v1 comparison. Prompt v2 is the paper's production prompt; prompt v1 isn't recommended for deployment and re-running its cross-model matrix would add compute for no headline contribution.
- Cross-model × Sonnet 4.6 as judge. §6.5 already shows Sonnet 4.6 and Haiku 4.5 achieve the same 100% catch rate under prompt v2 at `none` effort; the cross-model $\Delta$GES should therefore be pipeline-invariant across those two judge tiers. Testing both would add compute without signal.
- T3.1 coverage. 100% hijack across all models regardless of defence because exfiltration happens in the first agent turn; adding it here doesn't inform.
- Cross-model adversarial single-turn (§6.5) re-run with the recommended pipeline. That's already §6.5; the re-do would be redundant.

## Dependencies on other open items

- **Complements:** `test-plan-opus-4-7-t3-4-2026-04-24.md` (completed in `results/opus-4-7-t3-all/`) — that plan extended Opus 4.7 T3.4 under the Stop-hook prototype; this plan extends it under the recommended pipeline.
- **Complements:** `test-plan-fpr-prompt-v2-2026-04-24.md` (completed in `results/test15/`) — that plan validated prompt v2 FPR on legitimate single-turn tasks; this plan validates prompt v2 on multi-turn attack scenarios.
- **Does not depend on:** the prompt-reduction corpus (`test-plan-prompt-reduction-corpus-2026-04-24.md`) — orthogonal concern, spun off to p17.
