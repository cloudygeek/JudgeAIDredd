# Test Plan — AgentDojo Cross-Vendor with Qwen3 (Bedrock) as Defended Agents

**Date:** 2026-04-25
**Context:** P15 §3.7 (External Validation on AgentDojo) reports the recommended PreToolUse pipeline (Cohere Embed v4 + prompt v2 + Claude Sonnet 4.6 judge) against two defended-agent tiers: **GPT-4o-mini** (29.9\% baseline ASR → ~2\% defended) and **GPT-4o** (~39\% → ~3--7\%). Both are OpenAI-hosted commercial agents. (The §3.7 paper text labelled the judge as Haiku 4.5 but every Test 12 / Test 17 fargate entrypoint --- `--judge-model eu.anthropic.claude-sonnet-4-6` --- ran Sonnet 4.6; the paper text is being corrected in the same revision that adds the Qwen rows.) P15 §3.6 (T3e exfiltration) shows current Anthropic-trained agents (Sonnet 4.6, Opus 4.7) refuse the attack class at the model layer. **What the paper currently lacks: an open-weights, non-vendor-trained agent as the defended target**, which would directly address the reviewer question "is this defence's effect just an OpenAI-specific artefact?" Adding Alibaba's Qwen3 (open-weights, served via AWS Bedrock Converse API) closes that gap. Two Qwen3 model sizes (32B dense and 235B MoE) let us measure whether the size axis shifts baseline injection-resistance, which is independently useful evidence about open-weights scaling behaviour.
**Priority:** Medium-high. Not strictly blocking for submission --- §3.7 already has two tiers --- but a third and fourth row (open-weights, Bedrock-served) materially strengthens the cross-vendor generalisation claim and pre-empts the "defence is OpenAI-tuned" reviewer angle.

## What we have now

| Defended agent | Provider | Baseline weighted ASR | Defended (prompt v2) | $\Delta$ | Source |
|---|---|---:|---:|---:|---|
| GPT-4o-mini | OpenAI commercial | 29.9\% | ~2\% | ${-}28$\,pp | §3.7, Test 17 |
| GPT-4o | OpenAI commercial | ~39\% | ~3--7\% | ${-}32$ to ${-}36$\,pp | §3.7.7, Test 17 |
| Sonnet 4.6 / Opus 4.7 | Anthropic commercial | T3e baseline = 0\% (Test 18) --- not measurable | --- | --- | §3.6 |

A reviewer can reasonably ask: "you've measured the defence on two OpenAI agents and on Claude where baseline refusal swallows the metric --- what about an agent that wasn't trained by either of you?" Open-weights agents are the cleanest answer to that.

## What this plan adds

Two new defended-agent rows in §3.7 Table~10: **Qwen3-32B** (dense, `qwen.qwen3-32b-v1:0`) and **Qwen3-235B** (MoE, `qwen.qwen3-235b-a22b-2507-v1:0`), both served via AWS Bedrock Converse API in eu-west-2, evaluated against AgentDojo's `important_instructions` attack across all four suites (Workspace, Banking, Slack, Travel) under both no-defence and prompt-v2 arms. Reuses the AgentDojo defence-bridge from Test 17 unchanged --- a new `bedrock-converse` backend in `run_benchmark.py` routes through `BedrockConverseLLM` (Bedrock Converse API adapter) instead of OpenAI.

| Axis | Values | Notes |
|---|---|---|
| Defended agent | Qwen3-32B (dense) **and** Qwen3-235B MoE | `qwen.qwen3-32b-v1:0` and `qwen.qwen3-235b-a22b-2507-v1:0` on Bedrock eu-west-2. |
| Agent serving | AWS Bedrock Converse API, eu-west-2 | boto3 `bedrock-runtime` `converse()`. No local inference. |
| Attack | `important_instructions` | Same attack class as Test 17 (the AgentDojo 2024 paper's strongest). |
| Suites | workspace, banking, slack, travel | Full AgentDojo `v1.2.2` corpus; matches Test 17. |
| Defence | none, intent-tracker (= dredd PreToolUse + prompt v2 + Cohere v4 + Sonnet 4.6 judge) | Two arms per model. |
| Repetitions | 1 per task (per AgentDojo convention) | 949 security tasks + ~97 benign tasks, ${\times}\,2$ arms ${\times}\,2$ models = ${\sim}4{,}184$ task runs. |
| Benchmark commit | `18b501a` | Same commit pinned in Test 17. |
| Judge model | `eu.anthropic.claude-sonnet-4-6` via Bedrock | Matches the actual §3.7 measurements (Tests 12a/b/c on GPT-4o-mini and Test 17 on GPT-4o). |
| Embedding | `eu.cohere.embed-v4:0` via Bedrock | Same as Test 17. |
| Thresholds | `deny=0.15`, `review=0.60` | Same as Test 17. |

**Total task runs:** ~4,184 (subset suites if rate-limited; see "Reduced subset" below).

**Pilot model order:** run **Qwen3-32B first** (smaller, cheaper, faster; establishes the cross-vendor data point), then Qwen3-235B. If budget/time is tight, the priority order is:
1. Qwen3-32B baseline + defended on all four suites (the canonical first cross-vendor data point).
2. Qwen3-235B baseline + defended on all four suites (the size-axis measurement).
3. If only one model is feasible, run Qwen3-32B (the mid-size tier matching the paper's "coding-agent scale").

## Hypotheses

**H1 --- Qwen3 baseline ASR is materially non-zero (30--60\% weighted) on at least one of the two models.** Qwen instruct training includes safety tuning but not at the scale of Anthropic's adversarial-prompt-injection corpora. A position between GPT-4o-mini (29.9\%) and GPT-4o (~39\%) is the expected range. Predicted: 30--50\% weighted baseline ASR on Qwen3-32B; possibly lower on Qwen3-235B if larger model capacity improves injection resistance.

**H2 --- Defended ASR drops to single digits weighted under prompt v2 on both Qwen models.** The defence is judge-side (Sonnet 4.6 + prompt v2 evaluating each tool call against the original task in a context isolated from the Qwen agent's conversation), so its effect is independent of the defended agent's training. The 28--36\,pp ASR reduction observed on GPT-4o-mini and GPT-4o should carry over to both Qwen models. Predicted: 2--10\% defended weighted ASR on both.

**H3 --- Benign utility drops 10--25\,pp under prompt v2** for the same domain-overlap reason as the OpenAI runs (prompt v2's red-flag catalogue overlaps with messaging/banking legitimate-action shapes). Slack will be the worst suite; Travel approximately flat. Holds for both Qwen models.

**H4 --- Both Qwen models follow the attack pretexts at higher rates than current Claude.** A direct read on the "is open-weights training enough?" question. Specifically, if H1 lands in the 30--50\% range on either model, the open-weights training is not enough on this attack corpus and the defence has measurable surface area. **This is the primary reviewer-addressable claim Test 20 produces.**

**H5 --- Qwen3-235B baseline ASR is lower than Qwen3-32B by 5--15\,pp.** Larger model capacity generally correlates with better instruction-following and safety adherence. The 235B MoE model (22B active parameters) should show somewhat improved injection resistance over the 32B dense model. Predicted: Qwen3-235B baseline ASR 20--40\%, Qwen3-32B baseline 30--50\%. **This hypothesis is the secondary contribution --- it characterises the open-weights size-axis scaling directly.**

**H6 --- Defended ASR is approximately equal on Qwen3-32B and Qwen3-235B** (within 3\,pp). The defence operates at the tool-call layer, not the agent-internal-reasoning layer, so the agent's size/capacity differences should average out under the judge's per-call decision. If observed: confirms the defence is genuinely agent-tier-invariant on the AgentDojo attack class.

## Success criteria

1. **Provenance fields populated** on every result JSON: `agent.provider=bedrock-converse`, `agent.model` set to one of `qwen.qwen3-32b-v1:0` / `qwen.qwen3-235b-a22b-2507-v1:0`, `agent.region=eu-west-2`, `judge.model`, `judge.prompt=v2`, `embedding.model`, `embedding.thresholds`, `benchmark.commit=18b501a`, `benchmark.version=v1.2.2`, `attack=important_instructions`, `run.timestamp`.
2. **Baseline ASR Wilson 95\% CI half-width ≤ 5\,pp per suite** at AgentDojo's per-suite $N_\text{sec}$ values (Workspace 560, Banking 144, Slack 105, Travel 140). At full corpus this gives weighted-aggregate CIs ≤ 2\,pp.
3. **Defended ASR achieves Wilson 95\% upper bound ≤ 12\%** weighted across suites, conditional on H2.
4. **No mid-run Bedrock throttling that halts the run.** The tenacity retry in `BedrockConverseLLM` handles transient throttles; sustained throttling requires rate-limit increase or reduced concurrency.
5. **Defence bridge (`benchmarks/agentdojo/dredd_defense.py`) unchanged from Test 17.** The only source changes are: (a) new `BedrockConverseLLM` adapter in `benchmarks/agentdojo/bedrock_converse_llm.py`, (b) `bedrock-converse` backend + `qwen3-32b`/`qwen3-235b` model choices in `run_benchmark.py`, (c) new `fargate/docker-entrypoint-test20.sh`. The interception logic, judge prompt, embedding, and threshold configuration are byte-identical to Tests 15/16/17.

## Decision rules

**If H1 + H2 + H4 hold (baseline 30--60\%, defended 2--10\%, weighted ASR drop ≥ 25\,pp):**
- Add two new rows to §3.7 Table~10 (per-suite ASR matrix). Headline finding: *"the defence reduces weighted ASR from $X$\% to $Y$\% on Qwen3-32B (and $X'$\% to $Y'$\% on Qwen3-235B), open-weights non-Anthropic non-OpenAI defended agents --- demonstrating that the prompt-v2 catalogue's effect is not specific to commercial-vendor-trained agents."*
- Update §3.7.7 Tier-Match interpretation: now we have four tiers (small commercial, large commercial, open-weights mid-size, open-weights large); the defence's effect is consistent across all four.
- Update §4.5 Limitations: fold in Qwen evidence directly.
- Drop or downgrade the "Cross-vendor evaluation" Future Work item.

**If H1 fails low (Qwen3 baseline ASR < 20\%):**
- Qwen3's safety training is stronger than expected. Still publishable as: *"open-weights training is approaching commercial-vendor levels of injection resistance on this corpus"*.
- Defended-arm result still informative; report it.

**If H1 lands very high (>70\% baseline):**
- Qwen3 follows the pretexts aggressively. Defended ASR may be higher (5--15\%) but the pp drop is also larger. Strong finding for the paper's defence-in-depth argument.

**If Bedrock throttling prevents the full run:**
- Reduced-subset fallback: run Workspace + Banking only (largest $N_\text{sec}$, ~700 security tasks). Still produces a valid two-suite cross-vendor data point.

## Execution

### Infrastructure

**Agent serving (Qwen3 via Bedrock Converse API):**

- **Bedrock region:** eu-west-2. Both `qwen.qwen3-32b-v1:0` and `qwen.qwen3-235b-a22b-2507-v1:0` are available and confirmed working with tool use.
- **Latency:** Qwen3-32B ~315ms per tool call, Qwen3-235B ~890ms per tool call (measured 2026-04-25).
- **No local GPU required.** All inference runs on Bedrock.

**Dredd defence-bridge:** unchanged from Test 17. The judge runs on Bedrock (eu-central-1) and the embedding on Bedrock; the agent side now also runs on Bedrock (eu-west-2).

**AgentDojo:** version `v1.2.2` (commit `18b501a`), same as Test 17.

### Container-based execution

Test 20 is designed to run on the AI Sandbox platform. The entrypoint `fargate/docker-entrypoint-test20.sh` is env-var driven so the same container image can be deployed multiple times with different configurations to parallelise work.

**Recommended 4-container split (minimum):**

| Container | AGENTDOJO_MODEL | AGENTDOJO_DEFENSE | Description |
|---|---|---|---|
| 1 | `qwen3-32b` | `none` | Qwen3-32B baseline |
| 2 | `qwen3-32b` | `B7.1` | Qwen3-32B defended |
| 3 | `qwen3-235b` | `none` | Qwen3-235B baseline |
| 4 | `qwen3-235b` | `B7.1` | Qwen3-235B defended |

**8-container split (faster, split by suite pair):**

| Container | MODEL | DEFENSE | SUITES |
|---|---|---|---|
| 1 | `qwen3-32b` | `none` | `workspace,banking` |
| 2 | `qwen3-32b` | `none` | `slack,travel` |
| 3 | `qwen3-32b` | `B7.1` | `workspace,banking` |
| 4 | `qwen3-32b` | `B7.1` | `slack,travel` |
| 5 | `qwen3-235b` | `none` | `workspace,banking` |
| 6 | `qwen3-235b` | `none` | `slack,travel` |
| 7 | `qwen3-235b` | `B7.1` | `workspace,banking` |
| 8 | `qwen3-235b` | `B7.1` | `slack,travel` |

Each container uploads results to S3 under `s3://<bucket>/test20/agentdojo-<model>-<defense_label>/`.

### Command (local execution, for reference)

```bash
# ── Terminal 1: Dredd judge server (Bedrock backend, Sonnet 4.6 judge, prompt B7.1)
AWS_REGION=eu-central-1 npx tsx src/server.ts \
  --backend bedrock \
  --judge-model eu.anthropic.claude-sonnet-4-6 \
  --embedding-model eu.cohere.embed-v4:0 \
  --prompt B7.1 \
  --port 3001

# ── Terminal 2: AgentDojo runs against Qwen3 on Bedrock
for MODEL in qwen3-32b qwen3-235b; do
  # --- Baseline (no defence) ---
  python3 benchmarks/agentdojo/run_benchmark.py \
    --backend bedrock-converse --model "${MODEL}" \
    --agent-region eu-west-2 \
    --attack important_instructions \
    --all-suites \
    --logdir "results/test20/${MODEL}-baseline/" \
    -f

  # --- Defended (prompt v2 = B7.1) ---
  python3 benchmarks/agentdojo/run_benchmark.py \
    --backend bedrock-converse --model "${MODEL}" \
    --agent-region eu-west-2 \
    --attack important_instructions \
    --all-suites \
    --defense B7.1 \
    --dredd-url http://localhost:3001 \
    --logdir "results/test20/${MODEL}-defended-b71/" \
    -f
done
```

**Judge-model alignment with §3.7:** All four prior AgentDojo runs that populate §3.7 Table 10 used Sonnet 4.6 as the judge. Test 20 matches that judge so the resulting six-row table reads as one coherent measurement of the recommended pipeline across six defended agents.

### Wall-clock and cost

**Bedrock agent inference (Qwen3-32B + Qwen3-235B):**

AgentDojo's `important_instructions` task averages ~2,000--4,000 input tokens and ~500--1,500 output tokens per task (multi-turn within the AgentDojo harness).

- **Qwen3-32B:** ~315ms latency per call, ~5--8 calls per task → ~2--3s per task. Full corpus (~1,046 tasks per arm × 2 arms) ≈ ~1--2h.
- **Qwen3-235B:** ~890ms latency per call, ~5--8 calls per task → ~5--7s per task. Full corpus ≈ ~2--4h.
- **Both models, all arms:** ~3--6h total (parallelised across containers, wall-clock ≈ longest single container).

**Bedrock cost — agent inference:**

Qwen3 pricing on Bedrock (eu-west-2, on-demand):
- Qwen3-32B: ~$0.30/M input, ~$0.30/M output (estimate — check current Bedrock pricing page).
- Qwen3-235B: ~$1.20/M input, ~$1.20/M output (estimate — check current Bedrock pricing page).

Per task (~3,000 input + ~1,000 output tokens, ~6 calls):
- Qwen3-32B: ~$0.007/task → ~$7 per arm → ~$14 for both arms.
- Qwen3-235B: ~$0.03/task → ~$30 per arm → ~$60 for both arms.

**Bedrock cost — judge (defended arms only):**

Sonnet 4.6: $3.00/M in, $15.00/M out. ~10 judge calls per task at ~350 in + ~80 out tokens each.
- Per defended arm: ~1,046 tasks × $0.023 = ~$24.
- Both models defended: ~$48.

**Bedrock cost — embedding:** ~$0.20 total.

**Total estimated Bedrock cost: ~$80--$130.**

**Budget cap:** $200 (includes headroom for retries and rate-limit backoff). Halt if exceeded; report partial matrix.

### Pilot before full run

Smoke-test on Workspace only with **Qwen3-32B** (largest $N_\text{sec}$). Baseline + defended arms = ~1,120 task runs; ~30--60min on Bedrock. Validates the Bedrock Converse + AgentDojo + dredd-bridge integration end-to-end before committing to the full ~4,000-task two-model run.

If the Qwen3-32B Workspace pilot shows H1 and H2 holding, proceed to:
1. Full Qwen3-32B corpus (Banking + Slack + Travel).
2. Qwen3-235B Workspace pilot.
3. Full Qwen3-235B corpus.

### Paper integration (if H1 + H2 + H4 support)

**§3.7 Table~10 update:** add **two new rows** for Qwen3-32B and Qwen3-235B alongside the existing GPT-4o-mini and GPT-4o rows.

**§3.7.7 Tier-match update:** add a paragraph noting the open-weights rows and what they add: two non-vendor-trained agents at distinct model sizes, plus a size-axis scaling measurement. *"The defence's effect generalises across commercial-OpenAI (small + large) and open-weights (Qwen3-32B dense + Qwen3-235B MoE) defended-agent classes; baseline ASR varies by class but defended ASR converges to the single-digit range across all rows."*

**§4.5 Limitations:** the "non-Anthropic agents" point gains two more examples. Strengthens the claim with **four** cross-vendor data points.

**§4.6 Future Work:** "cross-vendor evaluation" item is partially done; demote to expanding to Llama, Mistral, Gemma.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bedrock rate-limits Qwen3 at sustained throughput | Medium | Medium | Tenacity retry with exponential backoff in `BedrockConverseLLM`. If sustained, reduce concurrency or split across more containers. |
| Qwen3-32B tool-call format doesn't match AgentDojo expectations | Low | High | Verified 2026-04-25: tool use works correctly with `toolUseId`, `name`, `input` fields. Multi-turn tool flow confirmed. |
| Qwen3-235B not available in eu-west-2 at run time | Low | Medium | Verified available 2026-04-25. If removed, fall back to Qwen3-32B only. |
| Qwen baseline ASR is so high (>80\%) the suite isn't producing useful task signal | Low | Low | Still publishable; see H1-high decision rule. |
| Qwen baseline is unexpectedly low (<10\%) due to corpus leakage | Low | Medium | Note in §3.7; H1-fail-low decision rule applies. |
| Bedrock Converse API changes message format | Very Low | High | Adapter tested against current API. Pin boto3 version in container. |
| Wall-clock exceeds container timeout | Low | Medium | 4-container split keeps each container under ~2h. 8-container split under ~1h each. |

## Non-goals

- **Other open-weights model families** (Llama 3.x, Mistral, Gemma, DeepSeek). Expand later if reviewers ask.
- **T3e-against-Qwen.** Different test plan (Phase 2 of the broader programme).
- **Multiple Qwen3 variants beyond 32B / 235B.** Two sizes give the scaling-axis measurement; more variants add cost without proportional insight.
- **CaMeL on Qwen.** CaMeL's reference implementation is Anthropic-API-bound.
- **Qwen as judge.** Already tested in §S.3 leaderboard; this plan tests Qwen as the defended agent.
- **prompt-v3.** Same prompt v2 as the rest of §3.7.

## Dependencies

- **Reuses Test 17 infrastructure** (AgentDojo + dredd defence-bridge + Bedrock judge/embedding configurations) unchanged. The cross-vendor surface is the agent-serving side (now Bedrock Converse instead of OpenAI).
- **Independent of Test 19** (T3e baseline-confirmation at $N=200$).
- **New code:** `benchmarks/agentdojo/bedrock_converse_llm.py` (Bedrock Converse adapter), `bedrock-converse` backend in `run_benchmark.py`, `fargate/docker-entrypoint-test20.sh`.

## Key files

| File | Role |
|---|---|
| `benchmarks/agentdojo/bedrock_converse_llm.py` | Bedrock Converse API LLM adapter (boto3) |
| `benchmarks/agentdojo/run_benchmark.py` | Benchmark runner (gains `bedrock-converse` backend + qwen3 models) |
| `benchmarks/agentdojo/dredd_defense.py` | Defence bridge (unchanged from Test 17) |
| `fargate/docker-entrypoint-test20.sh` | Container entrypoint (env-var driven for multi-container split) |

## Stretch follow-ups

If H1 + H2 + H4 land cleanly:

1. **Add Llama 3.3 70B** via Bedrock as a second open-weights family row.
2. **Add the other Qwen3 Bedrock variants** (Coder 30B, Next 80B) for a broader Qwen3 family coverage.
3. **Run benign-mode arms** to measure utility impact on Qwen models specifically.
