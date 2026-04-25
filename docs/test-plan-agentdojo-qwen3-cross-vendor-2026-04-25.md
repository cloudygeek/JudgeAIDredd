# Test Plan — AgentDojo Cross-Vendor with Qwen3.5 and Qwen3.6 (Local) as Defended Agents

**Date:** 2026-04-25
**Context:** P15 §3.7 (External Validation on AgentDojo) reports the recommended PreToolUse pipeline (Cohere Embed v4 + prompt v2 + Claude Sonnet 4.6 judge) against two defended-agent tiers: **GPT-4o-mini** (29.9\% baseline ASR → ~2\% defended) and **GPT-4o** (~39\% → ~3--7\%). Both are OpenAI-hosted commercial agents. (The §3.7 paper text labelled the judge as Haiku 4.5 but every Test 12 / Test 17 fargate entrypoint --- `--judge-model eu.anthropic.claude-sonnet-4-6` --- ran Sonnet 4.6; the paper text is being corrected in the same revision that adds the Qwen rows.) P15 §3.6 (T3e exfiltration) shows current Anthropic-trained agents (Sonnet 4.6, Opus 4.7) refuse the attack class at the model layer. **What the paper currently lacks: an open-weights, self-hosted, non-vendor-trained agent as the defended target**, which would directly address the reviewer question "is this defence's effect just an OpenAI-specific artefact?" Adding Alibaba's Qwen3.5 and Qwen3.6 (open-weights instruct line, served locally via Ollama) closes that gap with no commercial agent-API cost. Two consecutive Qwen point releases also let us measure whether the ${\sim}3$\,month gap between Qwen3.5 and Qwen3.6 shifts baseline injection-resistance training, which is independent useful evidence about open-weights training trajectories.
**Priority:** Medium-high. Not strictly blocking for submission --- §3.7 already has two tiers --- but a third row (open-weights, ${\sim}\$2$ Bedrock cost on the judge side) materially strengthens the cross-vendor generalisation claim and pre-empts the "defence is OpenAI-tuned" reviewer angle.

## What we have now

| Defended agent | Provider | Baseline weighted ASR | Defended (prompt v2) | $\Delta$ | Source |
|---|---|---:|---:|---:|---|
| GPT-4o-mini | OpenAI commercial | 29.9\% | ~2\% | ${-}28$\,pp | §3.7, Test 17 |
| GPT-4o | OpenAI commercial | ~39\% | ~3--7\% | ${-}32$ to ${-}36$\,pp | §3.7.7, Test 17 |
| Sonnet 4.6 / Opus 4.7 | Anthropic commercial | T3e baseline = 0\% (Test 18) --- not measurable | --- | --- | §3.6 |

A reviewer can reasonably ask: "you've measured the defence on two OpenAI agents and on Claude where baseline refusal swallows the metric --- what about an agent that wasn't trained by either of you?" Open-weights agents are the cleanest answer to that.

## What this plan adds

Two new defended-agent rows in §3.7 Table~10: **Qwen3.5-35B-Instruct** and **Qwen3.6-35B-Instruct**, both served locally via Ollama, evaluated against AgentDojo's `important_instructions` attack across all four suites (Workspace, Banking, Slack, Travel) under both no-defence and prompt-v2 arms. Reuses the AgentDojo defence-bridge from Test 17 unchanged --- only the agent-side `--model` flag changes between the two model variants.

| Axis | Values | Notes |
|---|---|---|
| Defended agent | Qwen3.5-35B-Instruct **and** Qwen3.6-35B-Instruct (Ollama tags `qwen3.5:35b` and `qwen3.6:35b`; the 32B tier the original plan targeted does not exist in Ollama's library — 27B and 35B are the actual mid-size variants on offer, and 35B is the closer match to the "mid-size open-weights tier" framing). | Q4_K_M quantisation by default (~22\,GB on disk); Q5 / Q8 acceptable if hardware allows. Lock the digest hash for each in the result JSONs. |
| Agent serving | Ollama at `http://localhost:11434/v1` | OpenAI-compatible API; AgentDojo's OpenAI provider points at it via `OPENAI_API_BASE`. |
| Attack | `important_instructions` | Same attack class as Test 17 (the AgentDojo 2024 paper's strongest). |
| Suites | workspace, banking, slack, travel | Full AgentDojo `v1.2.2` corpus; matches Test 17. |
| Defence | none, intent-tracker (= dredd PreToolUse + prompt v2 + Cohere v4 + Sonnet 4.6 judge) | Two arms per model. |
| Repetitions | 1 per task (per AgentDojo convention) | 949 security tasks + ~97 benign tasks, ${\times}\,2$ arms ${\times}\,2$ models = ${\sim}4{,}184$ task runs. |
| Benchmark commit | `18b501a` | Same commit pinned in Test 17. |
| Judge model | `eu.anthropic.claude-sonnet-4-6` via Bedrock | Matches the actual §3.7 measurements (Tests 12a/b/c on GPT-4o-mini and Test 17 on GPT-4o, all using `--judge-model eu.anthropic.claude-sonnet-4-6` per the fargate entrypoint scripts). Sonnet 4.6 is the recommended-pipeline judge per §4.7 Conclusions. Tests 15 + 16 (Claude × T3 cross-model) used Haiku 4.5 because they are recommended-pipeline-on-Claude experiments where Haiku is the cost-efficient alternative; the AgentDojo external-validation row deliberately uses the headline-recommendation judge. |
| Embedding | `eu.cohere.embed-v4:0` via Bedrock | Same as Test 17. |
| Thresholds | `deny=0.15`, `review=0.60` | Same as Test 17. |

**Total task runs:** ~4{,}184 (subset suites if hardware-bound; see "Reduced subset" below).

**Pilot model order:** run **Qwen3.5 first** (older, more likely to be reproducible against historical literature), then Qwen3.6. If hardware time is tight, the priority order is:
1. Qwen3.5 baseline + defended on all four suites (the canonical first cross-vendor data point).
2. Qwen3.6 baseline + defended on all four suites (the trajectory measurement).
3. If only one model is feasible, run Qwen3.6 (the newer release; reviewers ask about latest available open-weights).

## Hypotheses

**H1 --- Qwen3.x baseline ASR is materially non-zero (30--60\% weighted) on at least one of the two variants.** Qwen instruct training includes safety tuning but not at the scale of Anthropic's adversarial-prompt-injection corpora. A position between GPT-4o-mini (29.9\%) and GPT-4o (~39\%) is the expected range. Predicted: 30--50\% weighted baseline ASR on Qwen3.5; possibly lower on Qwen3.6 if injection-resistance training has tightened in the newer release (see H5 below).

**H2 --- Defended ASR drops to single digits weighted under prompt v2 on both Qwen variants.** The defence is judge-side (Sonnet 4.6 + prompt v2 evaluating each tool call against the original task in a context isolated from the Qwen agent's conversation), so its effect is independent of the defended agent's training. The 28--36\,pp ASR reduction observed on GPT-4o-mini and GPT-4o should carry over to both Qwen point releases. Predicted: 2--10\% defended weighted ASR on both.

**H3 --- Benign utility drops 10--25\,pp under prompt v2** for the same domain-overlap reason as the OpenAI runs (prompt v2's red-flag catalogue overlaps with messaging/banking legitimate-action shapes). Slack will be the worst suite; Travel approximately flat. Holds for both Qwen variants.

**H4 --- Both Qwen variants follow the attack pretexts at higher rates than current Claude.** A direct read on the "is open-weights training enough?" question. Specifically, if H1 lands in the 30--50\% range on either variant, the open-weights training is not enough on this attack corpus and the defence has measurable surface area. **This is the primary reviewer-addressable claim Test 20 produces.**

**H5 --- Qwen3.6 baseline ASR is lower than Qwen3.5 by 5--15\,pp.** Each Qwen point release in the public history has incrementally added adversarial-prompt-injection examples to its post-training corpus; Qwen3.6 is the newer release and should benefit from any corpus-additions made between the two releases. Predicted: Qwen3.6 baseline ASR 10--40\%, Qwen3.5 baseline 30--50\%. **This hypothesis is the secondary contribution of running both models** --- it characterises the open-weights baseline-resistance trajectory directly and is independently informative regardless of how the defence numbers come out.

**H6 --- Defended ASR is approximately equal on Qwen3.5 and Qwen3.6** (within 3\,pp). The defence operates at the tool-call layer, not the agent-internal-reasoning layer, so the agent's training-time safety differences should average out under the judge's per-call decision. If observed: confirms the defence is genuinely agent-tier-invariant on the AgentDojo attack class. If H6 fails (defended ASR materially differs between Qwen3.5 and Qwen3.6): suggests an interaction between agent-internal reasoning and judge-call disposition worth investigating.

## Success criteria

1. **Provenance fields populated** on every result JSON: `agent.provider=ollama-openai`, `agent.model` set to one of `qwen3.5:35b` / `qwen3.6:35b`, `agent.modelDigest` (the Ollama digest hash), `agent.quantisation`, `judge.model`, `judge.prompt=v2`, `embedding.model`, `embedding.thresholds`, `benchmark.commit=18b501a`, `benchmark.version=v1.2.2`, `attack=important_instructions`, `run.timestamp`, `host.gpu` (or CPU spec for non-GPU runs).
2. **Baseline ASR Wilson 95\% CI half-width ≤ 5\,pp per suite** at AgentDojo's per-suite $N_\text{sec}$ values (Workspace 560, Banking 144, Slack 105, Travel 140). At full corpus this gives weighted-aggregate CIs ≤ 2\,pp.
3. **Defended ASR achieves Wilson 95\% upper bound ≤ 12\%** weighted across suites, conditional on H2.
4. **No mid-run Ollama crashes.** Local serving must be stable across the ~2{,}000 task runs. If Ollama OOMs or hangs mid-run, the test plan needs revising (e.g., to a smaller Qwen variant or quantisation).
5. **Defence bridge (`benchmarks/agentdojo/dredd_defense.py`) unchanged from Test 17.** The only source change is in the test harness `benchmarks/agentdojo/run_benchmark.py`, which gains two entries in the `OPENAI_MODELS` dict (`qwen3.5` → `qwen3.5:35b`, `qwen3.6` → `qwen3.6:35b`) and a friendly-name mapping that points Qwen at gpt-4o's attack template (since Qwen has no native AgentDojo-published attack variant). The interception logic, judge prompt, embedding, and threshold configuration are byte-identical to Tests 15/16/17. This preserves the cross-vendor-replication contract this test is designed to demonstrate.

## Decision rules

**If H1 + H2 + H4 hold (baseline 30--60\%, defended 2--10\%, weighted ASR drop ≥ 25\,pp):**
- Add a third row to §3.7 Table~10 (per-suite ASR matrix). Headline finding: *"the defence reduces weighted ASR from $X$\% to $Y$\% on Qwen3-35B-Instruct, an open-weights non-Anthropic non-OpenAI defended agent --- demonstrating that the prompt-v2 catalogue's effect is not specific to commercial-vendor-trained agents."*
- Update §3.7.7 Tier-Match interpretation: now we have three tiers (small commercial, large commercial, open-weights mid-size); the defence's effect is consistent across all three.
- Update §4.5 Limitations point on "current Claude refuses, defence is unnecessary": fold in Qwen evidence directly. The expanded answer becomes "...non-Anthropic agents (GPT-4o-mini 29.9\% baseline, GPT-4o 39\%, Qwen3-35B $X$\%) are not at the floor, and the defence reduces ASR by $\Delta$ pp on each."
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

**Local agent serving (Qwen3-35B via Ollama):**

- **Hardware requirements:** Qwen3-35B at Q4_K_M (~20\,GB on disk, ~22\,GB at runtime) needs a single GPU with 24\,GB+ VRAM, or a Mac with 32\,GB+ unified memory, or CPU-only at ~5\,tok/s (impractically slow). The author's M3 Max 128\,GB or any H100/A100/4090-class GPU is sufficient.
- **Setup:**
  ```bash
  ollama pull qwen3.5:35b   # 35B Q4_K_M default, ~22 GB
  ollama pull qwen3.6:35b   # 35B Q4_K_M default, ~22 GB (deduplicates layers if qwen3.6:latest already present)
  ollama serve              # binds to http://localhost:11434
  ollama show qwen3.5:35b   # capture the digest hash for provenance
  ollama show qwen3.6:35b   # capture the digest hash for provenance
  ```
- **Verification:** `curl -X POST http://localhost:11434/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"qwen3.5:35b","messages":[{"role":"user","content":"Say hi"}]}'` should return a chat completion within ~3\,s on GPU, ~30\,s on CPU. Repeat with `qwen3.6:35b`.

**Dredd defence-bridge:** unchanged from Test 17. The judge runs on Bedrock (`eu-west-1`) and the embedding on Bedrock (`eu-central-1`); only the agent side moves to local Ollama.

**AgentDojo:** version `v1.2.2` (commit `18b501a`), same as Test 17. Repository pinned via `pip install agentdojo==1.2.2`.

### Command

The canonical invocation from Test 17 (`fargate/docker-entrypoint-test17.sh`) is the reference. Adapted for local execution against Ollama-served Qwen agents:

```bash
# ── Terminal 1: Dredd judge server (Bedrock backend, Sonnet 4.6 judge, prompt B7.1)
AWS_REGION=eu-west-1 npx tsx src/server.ts \
  --backend bedrock \
  --judge-model eu.anthropic.claude-sonnet-4-6 \
  --embedding-model eu.cohere.embed-v4:0 \
  --prompt B7.1 \
  --port 3001
# (--deny-threshold 0.15 and --review-threshold 0.6 are server defaults; pass
#  explicitly if you want them in the result-JSON provenance)

# ── Terminal 2: Ollama serving the Qwen agents
ollama pull qwen3.5:35b
ollama pull qwen3.6:35b
ollama serve   # binds http://localhost:11434

# ── Terminal 3: AgentDojo runs against both
# The benchmarks/agentdojo/run_benchmark.py runner has been extended with
# --model qwen3.5 / --model qwen3.6 entries that map to qwen3.5:35b /
# qwen3.6:35b in OPENAI_MODELS. The defence bridge (dredd_defense.py) is
# unchanged from Test 17 — only the harness wiring grew Qwen support.

for MODEL in qwen3.5 qwen3.6; do
  MODEL_TAG="${MODEL/.//}-35b"   # qwen3.5-35b / qwen3.6-35b

  # --- Baseline (no defence: omit --defense, --dredd-url) ---
  OPENAI_BASE_URL=http://localhost:11434/v1 \
  OPENAI_API_KEY=ollama-stub \
  python3 benchmarks/agentdojo/run_benchmark.py \
    --backend openai --model "${MODEL}" \
    --attack important_instructions \
    --all-suites \
    --logdir "results/test20/${MODEL_TAG}-baseline/" \
    -f

  # --- Defended (prompt v2 = B7.1) ---
  OPENAI_BASE_URL=http://localhost:11434/v1 \
  OPENAI_API_KEY=ollama-stub \
  python3 benchmarks/agentdojo/run_benchmark.py \
    --backend openai --model "${MODEL}" \
    --attack important_instructions \
    --all-suites \
    --defense B7.1 \
    --dredd-url http://localhost:3001 \
    --logdir "results/test20/${MODEL_TAG}-defended-b71/" \
    -f

  # Capture model digest hash for provenance
  ollama show "${MODEL/./.}:35b" --modelfile > "results/test20/${MODEL_TAG}.modelfile.txt"
done
```

**Judge-model alignment with §3.7:** All four prior AgentDojo runs that populate §3.7 Table 10 (Test 12a / 12b / 12c on GPT-4o-mini and GPT-4o; Test 17 on the GPT-4o tier-match) used Sonnet 4.6 as the judge per the fargate entrypoint scripts. Test 20 matches that judge so the resulting four-row table reads as one coherent measurement of the recommended pipeline across four defended agents. Tests 15 + 16 used Haiku 4.5 but those are Claude × T3 measurements (different evaluation suite, where Haiku 4.5 is the cost-efficient alternative the paper documents in §4.7). The §3.7 paper text currently misidentifies the judge as Haiku 4.5; that text correction lands in the same paper revision that adds the Qwen rows.

### Wall-clock and cost

**Local agent inference (Qwen3.5 + Qwen3.6 35B at Q4_K_M each):**

- AgentDojo's `important_instructions` task averages ~2{,}000--4{,}000 input tokens and ~500--1{,}500 output tokens per task (multi-turn within the AgentDojo harness).
- Throughput estimates per host class, **per model** (full corpus baseline + defended):
  - **H100 80\,GB FP16:** ~150 tok/s aggregate. Per-task: ~10--15\,s. **~7--10\,h** per Qwen variant; ~14--20\,h for both.
  - **4090 24\,GB Q4:** ~40 tok/s. Per-task: ~30--45\,s. **~25--30\,h** per variant; ~50--60\,h for both (effectively two long weekends).
  - **M3 Max 128\,GB Q5:** ~25 tok/s. Per-task: ~50--80\,s. **~30--45\,h** per variant; ~60--90\,h for both.
  - **M3 Max 128\,GB Q4:** ~35 tok/s. Per-task: ~35--55\,s. **~22--30\,h** per variant; ~44--60\,h for both.

For a 2-model run on the M3 Max, plan ~3--5 overnight runs (with a smoke pilot on Workspace-only first). On H100/A100, plan a single 24-hour cycle.

**Bedrock cost (judge + embedding):**

A defended AgentDojo task triggers ~10 Sonnet 4.6 judge calls on average (most tool calls are auto-allowed or auto-denied by the Cohere v4 embedding stage; only the review-band ~20\% reach the judge). Each judge call is ~350 input + ~80 output tokens.

| Component | Per call | Per task (~10 calls) |
|---|---|---|
| Sonnet 4.6 (\$3.00/M in, \$15.00/M out) | \$0.0023 | **\$0.023** |

- **Defended arm, per model:** ~1{,}046 tasks × \$0.023 = **~\$24**.
- **Both models:** ~2{,}092 defended tasks × \$0.023 = **~\$48**.
- Range allowing for 8--14 calls/task and Qwen running ~20\% more tool calls than GPT-4o-mini per task: **\$40--\$95** total Sonnet judge cost.
- Embedding (Cohere v4 via Bedrock): ~\$0.20 across both defended arms.
- Baseline arms (no defence): ~\$0 Bedrock cost.
- **Total Bedrock cost: ~\$40--\$95.**

(Earlier draft of this plan estimated ~\$1--\$4 for the judge cost; that figure was off by ${\sim}30$--$50\times$ because it didn't multiply by ~10 judge invocations per task. Corrected here with Sonnet 4.6 pricing applied; Haiku 4.5 alternative would land at ~\$12--\$25, but is not the matched-judge configuration for this test.)

**OpenAI / commercial agent API cost: \$0** (both Qwen variants run locally via Ollama).

**Disk:** ~22\,GB per Q4 quantisation × 2 = ~44\,GB for both Qwen variants pulled to Ollama.

**Budget cap:** \$120 all-in (~25\% headroom on the high estimate). Halt if exceeded; report partial matrix.

### Pilot before full run

Smoke-test on Workspace only with **Qwen3.5 first** (largest $N_\text{sec}$, also the suite with the cleanest 0.0\% defended ASR on GPT-4o-mini in Test 17). Baseline + defended arms on one model = ~1{,}120 task runs; ~3--5\,h on M3 Max, ~2\,h on H100. Validates the Ollama + AgentDojo + dredd-bridge integration end-to-end before committing to the full ~4{,}000-task two-model run.

If the Qwen3.5 Workspace pilot shows H1 (baseline 30--50\%) and H2 (defended 2--10\%) holding, proceed to:
1. Full Qwen3.5 corpus (Banking + Slack + Travel).
2. Qwen3.6 Workspace pilot (validates that Qwen3.6 also runs cleanly via Ollama --- different model file, same harness).
3. Full Qwen3.6 corpus.

### Paper integration (if H1 + H2 + H4 support)

**§3.7 Table~10 update:** add **two new rows** for Qwen3.5-35B-Instruct and Qwen3.6-35B-Instruct alongside the existing GPT-4o-mini and GPT-4o rows. The table now spans four defended-agent rows across two vendors and the open-weights-mid-size class.

**§3.7.7 Tier-match update:** the section currently compares GPT-4o-mini (paper) to GPT-4o (CaMeL). Add a third paragraph noting the open-weights rows (Qwen3.5 and Qwen3.6) and what they add: two non-vendor-trained agents at distinct positions on the trade-off curve, plus a within-vendor trajectory measurement (Qwen3.5 → Qwen3.6 baseline-resistance shift). The "comparable to CaMeL at its tier" framing extends to: *"the defence's effect generalises across commercial-OpenAI (small + large) and open-weights (Qwen3.5 + Qwen3.6) defended-agent classes; baseline ASR varies by class but defended ASR converges to the single-digit range across all four rows"*.

**§4.5 Limitations pre-emption updates:** the second of the five points ("non-Anthropic agents tested on the same attack class are not at the floor") gains two more examples beyond the GPT-4o pair --- the Qwen3.5 and Qwen3.6 rows. Strengthens the "different agents follow these pretexts at materially different rates" claim with **four** clean cross-vendor data points (GPT-4o-mini, GPT-4o, Qwen3.5, Qwen3.6) instead of the current two.

**§4.6 Future Work:** "cross-vendor evaluation" item is partially done (two open-weights variants tested); demote to *"extends further to Llama, Mistral, and Gemini variants for a fuller open-weights × commercial coverage of the trade-off curve"*.

**Optional new sub-paragraph in §3.7:** an explicit Qwen3.5 → Qwen3.6 trajectory comment if H5 is supported. *"The two consecutive Qwen point releases tested here (Qwen3.5 and Qwen3.6, ~3 months apart) show a baseline-ASR shift of $\Delta$ pp under identical attack and harness conditions, characterising the open-weights injection-resistance training trajectory directly. Defended ASR is approximately equal across the two releases ($\le 3$\,pp), consistent with the defence's effect being agent-tier-invariant on the AgentDojo attack class."*

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ollama OOMs or hangs mid-run on Qwen3.x-35B | Medium | High | Pilot Workspace-only first per model; if OOM, drop to Q4_K_M (lower memory), or to Qwen3.x-27B as the smaller-tier alternative (the only smaller mid-size variant Ollama publishes for this line) |
| AgentDojo's tool-use schema doesn't match Qwen's tool-call format on Ollama | Medium | High | Pilot smoke-test on Qwen3.5 will reveal this before the Qwen3.6 run starts. Ollama's OpenAI-compatible endpoint supports tool calls but per-model fidelity varies. If schema mismatches surface, may need a simple translation layer in the bridge. |
| Qwen3.6 not yet released or unavailable on Ollama at run time | Low--Medium | Medium | Verify both `ollama pull qwen3.5:35b` and `ollama pull qwen3.6:35b` succeed before kickoff. If Qwen3.6 isn't available, fall back to running Qwen3.5 only and note in the result that the trajectory hypothesis (H5) couldn't be tested. |
| Qwen baseline ASR is so high (>80\%) on either variant the suite isn't producing useful task signal (agent always derailed) | Low | Low | Still publishable as "open-weights agent on AgentDojo at this size class is highly susceptible at baseline; defence reduces it materially". |
| Qwen baseline is unexpectedly low (<10\%) on either variant due to AgentDojo corpus leakage into Qwen training | Low | Medium | Note in §3.7 that the AgentDojo `important_instructions` corpus has been public since 2024 and has likely been seen by post-2024 instruct training. The H1-fail-low decision rule applies. |
| Qwen3.5 and Qwen3.6 produce identical baseline ASR (H5 fails) | Medium | Low | Still publishable as "open-weights training trajectory has plateaued on this attack class" --- a finding in its own right. |
| Wall-clock exceeds available hardware time-budget for both models | Medium | Medium | Run Qwen3.5 first (full corpus); if hardware time runs out before Qwen3.6, ship Qwen3.5 only with a Future Work note. Reduced-subset fallback (Workspace + Banking only on both models) is the secondary fallback. |
| Bedrock judge rate limits trigger on rapid AgentDojo-defended task throughput | Low | Low | Same as Test 17; in-runner backoff handles it. ~25 Haiku calls per task is well under the eu-west-1 quota. |

## Non-goals

- **Other open-weights model families** (Llama 3.x, Mistral Large, Gemma, DeepSeek). Each adds compute time and an additional integration point. Two Qwen point releases give the open-weights coverage; expand to other families later if reviewers ask.
- **T3e-against-Qwen.** Different test plan (Phase 2 of the broader programme; needs a generic OpenAI-compatible executor that points at Qwen via Ollama). Held separately.
- **Multiple Qwen sizes within each release.** 35B is the sweet-spot for the paper's coding-agent context (and the closest variant Ollama publishes to the originally-targeted 32B mid-size tier). Both Qwen3.5 and Qwen3.6 at 35B; the 9B / 4B variants are too weak, the 122B variant is overkill for a defended-agent baseline. Single size class keeps the trajectory comparison (H5) clean.
- **Other Qwen point releases beyond 3.5 / 3.6.** If a Qwen3.7 or Qwen4 ships before submission, that's an exciting future-work item, but two consecutive releases is enough to characterise the trajectory direction.
- **CaMeL on Qwen.** CaMeL's reference implementation is Anthropic-API-bound; porting to Qwen is out of scope.
- **Anthropic's agent on Qwen-as-judge.** Qwen as the *judge* was already tested in §S.3 leaderboard (90\% accuracy, 7/10 hijacks); this plan tests Qwen as the *defended agent*, the symmetric case.
- **prompt-v3.** Same prompt v2 as the rest of the §3.7 measurements --- the cross-vendor question is whether the defence transfers, not whether prompt iteration improves further.

## Dependencies

- **Reuses Test 17 infrastructure** (AgentDojo + dredd defence-bridge + Bedrock judge/embedding configurations) unchanged. The cross-vendor surface is purely the agent-serving side.
- **Independent of Test 19** (T3e baseline-confirmation at $N=200$). Phase 1 confirms Claude resistance at higher $N$; Phase 2 (this plan) measures dredd's effect on a non-Claude agent. Different cells of the matrix.
- **Independent of the broader Phase 2 programme** (T3e against non-Claude agents). That requires a generic-OpenAI executor for T3e, which is ~1 day of code; this AgentDojo-against-Qwen plan reuses the existing AgentDojo bridge and is essentially zero engineering.

## Stretch follow-ups

If H1 + H2 + H4 land cleanly on both Qwen3.5 and Qwen3.6:

1. **Add Llama 3.3 70B-Instruct** as a second open-weights family row (~1 day of additional Ollama setup; serves as a "different family of open-weights" check).
2. **Add Qwen3.5-7B and Qwen3.6-7B** as smaller-tier comparators, to characterise the model-size effect within the open-weights Qwen family.
3. **Run the same matrix at higher reasoning-effort settings** if Qwen exposes them via Ollama (some Qwen3 builds support deliberation tokens; the size of that effect on AgentDojo is open).
4. **Add Qwen3.5 / 3.6 base (non-instruct) variants** to characterise whether the safety-tuning gap between base and instruct shows up on the AgentDojo metric.

These are stretch goals, not part of Phase 2 proper.
