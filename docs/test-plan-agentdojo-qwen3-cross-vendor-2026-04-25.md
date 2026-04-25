# Test Plan — AgentDojo Cross-Vendor with Qwen3 (Local) as Defended Agent

**Date:** 2026-04-25
**Context:** P15 §3.7 (External Validation on AgentDojo) currently reports the recommended PreToolUse pipeline (Cohere Embed v4 + prompt v2 + Claude Haiku 4.5 judge) against two defended-agent tiers: **GPT-4o-mini** (29.9\% baseline ASR → ~2\% defended) and **GPT-4o** (~39\% → ~3--7\%). Both are OpenAI-hosted commercial agents. P15 §3.6 (T3e exfiltration) shows current Anthropic-trained agents (Sonnet 4.6, Opus 4.7) refuse the attack class at the model layer. **What the paper currently lacks: an open-weights, self-hosted, non-vendor-trained agent as the defended target**, which would directly address the reviewer question "is this defence's effect just an OpenAI-specific artefact?" Adding Qwen3 (Alibaba's open-weights instruct line, served locally via Ollama) closes that gap with no commercial agent-API cost.
**Priority:** Medium-high. Not strictly blocking for submission --- §3.7 already has two tiers --- but a third row (open-weights, ${\sim}\$2$ Bedrock cost on the judge side) materially strengthens the cross-vendor generalisation claim and pre-empts the "defence is OpenAI-tuned" reviewer angle.

## What we have now

| Defended agent | Provider | Baseline weighted ASR | Defended (prompt v2) | $\Delta$ | Source |
|---|---|---:|---:|---:|---|
| GPT-4o-mini | OpenAI commercial | 29.9\% | ~2\% | ${-}28$\,pp | §3.7, Test 17 |
| GPT-4o | OpenAI commercial | ~39\% | ~3--7\% | ${-}32$ to ${-}36$\,pp | §3.7.7, Test 17 |
| Sonnet 4.6 / Opus 4.7 | Anthropic commercial | T3e baseline = 0\% (Test 18) --- not measurable | --- | --- | §3.6 |

A reviewer can reasonably ask: "you've measured the defence on two OpenAI agents and on Claude where baseline refusal swallows the metric --- what about an agent that wasn't trained by either of you?" Open-weights agents are the cleanest answer to that.

## What this plan adds

A third defended-agent row in §3.7 Table~10: **Qwen3-32B-Instruct**, served locally via Ollama, evaluated against AgentDojo's `important_instructions` attack across all four suites (Workspace, Banking, Slack, Travel) under both no-defence and prompt-v2 arms. Reuses the AgentDojo defence-bridge from Test 17 unchanged --- only the agent-side `--model-provider` flag changes.

| Axis | Values | Notes |
|---|---|---|
| Defended agent | Qwen3-32B-Instruct (Ollama tag `qwen3:32b` or equivalent) | Q4_K_M quantisation by default; Q5 / Q8 acceptable if hardware allows. Lock the digest hash in the result JSON. |
| Agent serving | Ollama at `http://localhost:11434/v1` | OpenAI-compatible API; AgentDojo's OpenAI provider points at it via `OPENAI_API_BASE`. |
| Attack | `important_instructions` | Same attack class as Test 17 (the AgentDojo 2024 paper's strongest). |
| Suites | workspace, banking, slack, travel | Full AgentDojo `v1.2.2` corpus; matches Test 17. |
| Defence | none, intent-tracker (= dredd PreToolUse + prompt v2 + Cohere v4 + Haiku 4.5 judge) | Two arms. |
| Repetitions | 1 per task (per AgentDojo convention) | 949 security tasks + ~97 benign tasks, ${\times}\,2$ arms = ${\sim}2{,}092$ task runs. |
| Benchmark commit | `18b501a` | Same commit pinned in Test 17. |
| Judge model | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` via Bedrock | Same as Test 17. |
| Embedding | `eu.cohere.embed-v4:0` via Bedrock | Same as Test 17. |
| Thresholds | `deny=0.15`, `review=0.60` | Same as Test 17. |

**Total task runs:** ~2{,}092 (subset suites if hardware-bound; see "Reduced subset" below).

## Hypotheses

**H1 --- Qwen3-32B baseline ASR is materially non-zero (30--60\% weighted).** Qwen3's instruct training includes safety tuning but not at the scale of Anthropic's adversarial-prompt-injection corpora. A position between GPT-4o-mini (29.9\%) and GPT-4o (~39\%) is the expected range, with a tail toward higher rates if Qwen's instruction-following beats its safety filtering on AgentDojo's pretexts. Predicted: 30--50\% weighted baseline ASR.

**H2 --- Defended ASR drops to single digits weighted under prompt v2.** The defence is judge-side (Haiku 4.5 + prompt v2 evaluating each tool call against the original task in a context isolated from the Qwen agent's conversation), so its effect is independent of the defended agent's training. The 28--36\,pp ASR reduction observed on GPT-4o-mini and GPT-4o should carry over. Predicted: 2--10\% defended weighted ASR.

**H3 --- Benign utility drops 10--25\,pp under prompt v2** for the same domain-overlap reason as the OpenAI runs (prompt v2's red-flag catalogue overlaps with messaging/banking legitimate-action shapes). Slack will be the worst suite; Travel approximately flat.

**H4 --- Qwen3 follows the attack pretexts at higher rates than Claude.** A direct read on the "is open-weights training enough?" question. Specifically, if H1 lands in the 30--50\% range, the open-weights training is not enough on this attack corpus and the defence has measurable surface area. **This is the primary reviewer-addressable claim Test 20 produces.**

## Success criteria

1. **Provenance fields populated** on every result JSON: `agent.provider=ollama-openai`, `agent.model=qwen3:32b`, `agent.modelDigest` (the Ollama digest hash), `agent.quantisation`, `judge.model`, `judge.prompt=v2`, `embedding.model`, `embedding.thresholds`, `benchmark.commit=18b501a`, `benchmark.version=v1.2.2`, `attack=important_instructions`, `run.timestamp`, `host.gpu` (or CPU spec for non-GPU runs).
2. **Baseline ASR Wilson 95\% CI half-width ≤ 5\,pp per suite** at AgentDojo's per-suite $N_\text{sec}$ values (Workspace 560, Banking 144, Slack 105, Travel 140). At full corpus this gives weighted-aggregate CIs ≤ 2\,pp.
3. **Defended ASR achieves Wilson 95\% upper bound ≤ 12\%** weighted across suites, conditional on H2.
4. **No mid-run Ollama crashes.** Local serving must be stable across the ~2{,}000 task runs. If Ollama OOMs or hangs mid-run, the test plan needs revising (e.g., to a smaller Qwen variant or quantisation).
5. **Same dredd defence-bridge code as Test 17 (no source changes).** Any code change other than CLI invocations is a violation of the cross-vendor-replication contract this test is designed to demonstrate.

## Decision rules

**If H1 + H2 + H4 hold (baseline 30--60\%, defended 2--10\%, weighted ASR drop ≥ 25\,pp):**
- Add a third row to §3.7 Table~10 (per-suite ASR matrix). Headline finding: *"the defence reduces weighted ASR from $X$\% to $Y$\% on Qwen3-32B-Instruct, an open-weights non-Anthropic non-OpenAI defended agent --- demonstrating that the prompt-v2 catalogue's effect is not specific to commercial-vendor-trained agents."*
- Update §3.7.7 Tier-Match interpretation: now we have three tiers (small commercial, large commercial, open-weights mid-size); the defence's effect is consistent across all three.
- Update §4.5 Limitations point on "current Claude refuses, defence is unnecessary": fold in Qwen evidence directly. The expanded answer becomes "...non-Anthropic agents (GPT-4o-mini 29.9\% baseline, GPT-4o 39\%, Qwen3-32B $X$\%) are not at the floor, and the defence reduces ASR by $\Delta$ pp on each."
- Drop or downgrade the "Cross-vendor evaluation" Future Work item (now partially done).

**If H1 fails low (Qwen3 baseline ASR < 20\%):**
- Qwen3's safety training is stronger than expected. The defence has less surface area to demonstrate effect.
- This is still publishable as: *"open-weights training is approaching commercial-vendor levels of injection resistance on this corpus"* --- a finding in its own right, with the caveat that the AgentDojo `important_instructions` corpus is now ~2 years old and may have leaked into Qwen's training data.
- Defended-arm result still informative; report it.

**If H1 lands very high (>70\% baseline):**
- Qwen3 follows the pretexts aggressively. Defended ASR may be higher than GPT-4o (5--15\% range) but the pp drop is also larger. Strong finding for the paper's defence-in-depth argument.
- Confirms that the open-weights tier needs the external defence layer more than the Anthropic tier does.

**If Ollama / hardware problems prevent the full run:**
- Reduced-subset fallback: run Workspace + Banking only (the two suites with largest $N_\text{sec}$, total ~700 security tasks). Still produces a valid two-suite cross-vendor data point, at the cost of weaker weighted-aggregate Wilson CIs.

## Execution

### Infrastructure

**Local agent serving (Qwen3-32B via Ollama):**

- **Hardware requirements:** Qwen3-32B at Q4_K_M (~20\,GB on disk, ~22\,GB at runtime) needs a single GPU with 24\,GB+ VRAM, or a Mac with 32\,GB+ unified memory, or CPU-only at ~5\,tok/s (impractically slow). The author's M3 Max 128\,GB or any H100/A100/4090-class GPU is sufficient.
- **Setup:**
  ```bash
  ollama pull qwen3:32b   # or qwen3:32b-instruct-q5_k_m for higher fidelity
  ollama serve            # binds to http://localhost:11434
  ollama show qwen3:32b   # capture the digest hash for provenance
  ```
- **Verification:** `curl -X POST http://localhost:11434/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"qwen3:32b","messages":[{"role":"user","content":"Say hi"}]}'` should return a chat completion within ~3\,s on GPU, ~30\,s on CPU.

**Dredd defence-bridge:** unchanged from Test 17. The judge runs on Bedrock (`eu-west-1`) and the embedding on Bedrock (`eu-central-1`); only the agent side moves to local Ollama.

**AgentDojo:** version `v1.2.2` (commit `18b501a`), same as Test 17. Repository pinned via `pip install agentdojo==1.2.2`.

### Command

```bash
# Terminal 1: start dredd's approval-judge server (same as Test 17)
AWS_REGION=eu-west-1 npm run server:bedrock:interactive -- \
  --prompt B7.1 \
  --judge-model eu.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --embedding-model eu.cohere.embed-v4:0 \
  --deny-threshold 0.15 \
  --review-threshold 0.60 \
  --port 8080 \
  --log-dir results/test20/dredd-server-logs/

# Terminal 2: start Ollama with Qwen3-32B preloaded
ollama serve  # leave running

# Terminal 3: AgentDojo benchmark — baseline (no defence)
OPENAI_API_BASE=http://localhost:11434/v1 \
OPENAI_API_KEY=ollama-stub \
python -m agentdojo.scripts.benchmark \
  --benchmark-version v1.2.2 \
  --suite workspace banking slack travel \
  --attack important_instructions \
  --model qwen3:32b \
  --model-provider openai \
  --no-defense \
  --logdir results/test20/qwen3-32b-baseline/

# Terminal 3 (after baseline completes): AgentDojo defended
OPENAI_API_BASE=http://localhost:11434/v1 \
OPENAI_API_KEY=ollama-stub \
python -m agentdojo.scripts.benchmark \
  --benchmark-version v1.2.2 \
  --suite workspace banking slack travel \
  --attack important_instructions \
  --model qwen3:32b \
  --model-provider openai \
  --defense-url http://localhost:8080/evaluate \
  --logdir results/test20/qwen3-32b-defended-b71/
```

(Actual flag names depend on the AgentDojo runner CLI; the canonical Test 17 invocation in `results/agentdojo-gpt4o-*/run-*.log` is the reference.)

### Wall-clock and cost

**Local agent inference (Qwen3-32B Q4_K_M):**

- AgentDojo's `important_instructions` task averages ~2{,}000--4{,}000 input tokens and ~500--1{,}500 output tokens per task (multi-turn within the AgentDojo harness).
- Throughput estimates per host class:
  - **H100 80\,GB FP16:** ~150 tok/s aggregate. Per-task: ~10--15\,s. Full corpus (~2{,}000 tasks both arms): **~7--10\,h** wall-clock.
  - **4090 24\,GB Q4:** ~40 tok/s. Per-task: ~30--45\,s. Full corpus: **~25--30\,h**.
  - **M3 Max 128\,GB Q5:** ~25 tok/s. Per-task: ~50--80\,s. Full corpus: **~30--45\,h**.
  - **M3 Max 128\,GB Q4:** ~35 tok/s. Per-task: ~35--55\,s. Full corpus: **~22--30\,h**.

Plan around the available hardware; if the run is on the M3 Max overnight, expect 2 nights of wall-clock.

**Bedrock cost (judge + embedding):**

- Judge invocations per defended task: ~15--25 Haiku 4.5 calls × ~350\,in/80\,out tokens × \$0.80/M\,in / \$4.00/M\,out = ~\$0.001/task.
- Defended arm: ~1{,}000 tasks × \$0.001 = **~\$1**.
- Embedding: ~\$0.10 across the run.
- Baseline arm: no judge calls. Cost ~\$0.
- **Total Bedrock cost: ~\$1--2.**

**OpenAI / commercial agent API cost: \$0** (Qwen runs locally).

**Budget cap:** \$5 all-in. Halt if exceeded (would require an unexpected ~50× cost overrun).

### Pilot before full run

Smoke-test on Workspace only (largest $N_\text{sec}$, also the suite with the cleanest 0.0\% defended ASR on GPT-4o-mini in Test 17). Baseline + defended arms = ~1{,}120 task runs; ~3--5\,h on M3 Max, ~2\,h on H100. Validates the Ollama + AgentDojo + dredd-bridge integration end-to-end before committing to the full ~2{,}000-task run. If the smoke pilot shows H1+H2 holding on Workspace alone, scale to all four suites.

### Paper integration (if H1 + H2 + H4 support)

**§3.7 Table~10 update:** add a Qwen3-32B-Instruct row alongside the GPT-4o-mini row.

**§3.7.7 Tier-match update:** the section currently compares GPT-4o-mini (paper) to GPT-4o (CaMeL). Add a third paragraph noting the open-weights row (Qwen3-32B) and what it adds: a non-vendor-trained agent at a third position on the trade-off curve. The "comparable to CaMeL at its tier" framing extends to: *"the defence's effect generalises across (at least) commercial-OpenAI, commercial-OpenAI-mini, and open-weights-mid-size defended-agent classes"*.

**§4.5 Limitations pre-emption updates:** the second of the five points ("non-Anthropic agents tested on the same attack class are not at the floor") gains a third example beyond the GPT-4o pair --- the Qwen row. Strengthens the "different agents follow these pretexts at materially different rates" claim with a clean third data point.

**§4.6 Future Work:** "cross-vendor evaluation" item is partially done (Qwen tested); demote to *"extends further to Llama, Mistral, and Gemini variants for a fuller open-weights × commercial coverage of the trade-off curve"*.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ollama OOMs or hangs mid-run on Qwen3-32B | Medium | High | Pilot Workspace-only first; if OOM, drop to Q4_K_M (lower memory), or to Qwen3-14B / Qwen2.5-32B as alternatives |
| AgentDojo's tool-use schema doesn't match Qwen's tool-call format on Ollama | Medium | High | Pilot smoke-test will reveal this. Ollama's OpenAI-compatible endpoint supports tool calls but per-model fidelity varies. If schema mismatches surface, may need a simple translation layer in the bridge |
| Qwen baseline ASR is so high (>80\%) the suite isn't producing useful task signal (agent always derailed) | Low | Low | Still publishable as "open-weights agent on AgentDojo at this size class is highly susceptible at baseline; defence reduces it materially". |
| Qwen baseline is unexpectedly low (<10\%) due to AgentDojo corpus leakage into Qwen training | Low | Medium | Note in §3.7 that the AgentDojo `important_instructions` corpus has been public since 2024 and has likely been seen by post-2024 instruct training. The H1-fail-low decision rule applies. |
| Wall-clock exceeds available hardware time-budget | Medium | Low | Reduced-subset fallback (Workspace + Banking only), or use a smaller Qwen variant (`qwen3:14b` or `qwen2.5:32b`) for faster inference at the cost of stronger baseline susceptibility |
| Bedrock judge rate limits trigger on rapid AgentDojo-defended task throughput | Low | Low | Same as Test 17; in-runner backoff handles it. ~25 Haiku calls per task is well under the eu-west-1 quota. |

## Non-goals

- **Other open-weights models** (Llama 3.x, Mistral Large, Gemma, DeepSeek). Each adds compute time and an additional integration point. Pick Qwen3 as the canonical first open-weights data point; expand later if reviewers ask.
- **T3e-against-Qwen.** Different test plan (Phase 2 of the broader programme; needs a generic OpenAI-compatible executor that points at Qwen via Ollama). Held separately.
- **Multiple Qwen sizes.** 32B is the sweet-spot for the paper's coding-agent context; 7B is too weak, 72B is overkill for a defended-agent baseline.
- **CaMeL on Qwen.** CaMeL's reference implementation is Anthropic-API-bound; porting to Qwen is out of scope.
- **Anthropic's agent on Qwen-as-judge.** Qwen as the *judge* was already tested in §S.3 leaderboard (90\% accuracy, 7/10 hijacks); this plan tests Qwen as the *defended agent*, the symmetric case.
- **prompt-v3.** Same prompt v2 as the rest of the §3.7 measurements --- the cross-vendor question is whether the defence transfers, not whether prompt iteration improves further.

## Dependencies

- **Reuses Test 17 infrastructure** (AgentDojo + dredd defence-bridge + Bedrock judge/embedding configurations) unchanged. The cross-vendor surface is purely the agent-serving side.
- **Independent of Test 19** (T3e baseline-confirmation at $N=200$). Phase 1 confirms Claude resistance at higher $N$; Phase 2 (this plan) measures dredd's effect on a non-Claude agent. Different cells of the matrix.
- **Independent of the broader Phase 2 programme** (T3e against non-Claude agents). That requires a generic-OpenAI executor for T3e, which is ~1 day of code; this AgentDojo-against-Qwen plan reuses the existing AgentDojo bridge and is essentially zero engineering.

## Stretch follow-ups

If H1 + H2 + H4 land cleanly:

1. **Add Llama 3.3 70B-Instruct** as a second open-weights row (~1 day of additional Ollama setup; serves as a "different family of open-weights" check).
2. **Add Qwen3-7B-Instruct** as a smaller-tier comparator, to characterise the model-size effect within the open-weights family.
3. **Run the same matrix at higher reasoning-effort settings** if Qwen exposes them via Ollama (some Qwen3 builds support deliberation tokens; the size of that effect on AgentDojo is open).

These are stretch goals, not part of Phase 2 proper.
