# Test Plan — Test 25: AgentLAB Long-Horizon Cross-Vendor Smoke

**Date:** 2026-04-27
**Source paper:** *AgentLAB: Benchmarking LLM Agents against Long-Horizon Attacks* (Jiang, Wang, Liang, Wang 2026; arXiv:2602.16901; cs.AI). Verified 2026-04-26 via `p15/sources/extract_20260426_arxiv_2602_16901.md`.
**Context:** P15 §3.6 now has cross-vendor T3e evidence on Bedrock-Qwen; §3.7 has cross-vendor AgentDojo on OpenAI agents. AgentLAB adds **a third independent attack-class corpus**: long-horizon adaptive multi-turn attacks across mutable environments. Five attack types span the §3.6 (intent hijacking) and §3.7 (task injection) attack classes plus three new axes (tool chaining, objective drifting, memory poisoning). The memory-poisoning axis is structurally out-of-scope for any PreToolUse-gate defence including dredd, which is an honest scope-boundary finding the paper benefits from disclosing.
**Priority:** Medium. With Test 24 blocked on MT-AgentRisk's HF gate, AgentLAB is the next-best multi-turn external corroboration. **Smoke-only scope** ($N=10$ per cell, ~140 trajectories) makes this an integration-validation + per-attack-type triage rather than a full benchmark replication.

## What we have now

| Attack class | Corpus | Coverage on dredd |
|---|---|:---:|
| Multi-turn goal hijacking on hand-crafted scenarios | P14 T3 / T3e | ✓ Anthropic floor (Test 19, $N=600$); Bedrock-Qwen 25--45% baseline (Test 23) |
| Single-turn `important_instructions` tool-output injection | AgentDojo | ✓ GPT-4o-mini, GPT-4o (§3.7) |
| **Long-horizon adaptive multi-turn attacks across mutable environments (5 attack types)** | **AgentLAB** | **gap** |

## What this plan adds

A smoke-level cross-vendor matrix on AgentLAB: 7 already-tested defended agents × 2 arms × $N=10$ per cell = **140 trajectories**. Stratified scenario sampling: 2 scenarios per attack type × 5 attack types = 10 scenarios per cell. Headline metric is per-(agent, arm, attack-type) attack success rate (ASR) labelled by the AgentLAB-style judge (transcript → succeeded / refused / failed).

| Axis | Values | Notes |
|---|---|---|
| Defended agent | Anthropic: **Haiku 4.5**, **Sonnet 4.6**, **Opus 4.6**, **Opus 4.7** (Bedrock `eu-west-1`); Bedrock-Qwen: **Qwen3 32B** (`qwen.qwen3-32b-v1:0`), **Qwen3 235B A22B** (`qwen.qwen3-235b-a22b-2507-v1:0`), **Qwen3 Coder 30B** (`qwen.qwen3-coder-30b-v1:0`) (Bedrock `eu-central-1`) | Seven rows, all on Bedrock. Same agent set tested in P14 §3.5 / Test 18 / Test 19 / Test 23 — directly comparable cross-corpus. |
| Defence arm | none, intent-tracker (= dredd PreToolUse + prompt v2 + Cohere v4 + Sonnet 4.6 judge) | Same two arms as §3.6 / §3.7 / Test 23 |
| Attack type | Intent hijacking, tool chaining, task injection, objective drifting, **memory poisoning** | All 5 from the verified abstract; 2 scenarios sampled per type with seeded RNG |
| Scenarios per (agent, arm) cell | 10 (stratified: 2 per attack type) | Smoke-level $N$ — Wilson 95\% CI half-width ~26\,pp per cell at $p{=}0.5$ (per review question 2 correction). Per-attack-type within a cell: $N=2$, half-width ~52\,pp — not informative individually. |
| Per-attack-type aggregation | $N=14$ pooling across all 7 agents within one arm (2 scenarios × 7 agents) | Wilson 95\% CI half-width ~26\,pp at $p{=}0.5$; useful only for rough cross-attack-type direction. **The cross-vendor question is per-(agent, arm, attack-type) ASR which stays at $N=2$; only the cross-vendor-pooled direction tightens to $N=14$.** |
| All-agent pooled aggregate per arm | $N=70$ (7 agents × 10 scenarios) | Wilson 95\% CI half-width ~12\,pp — but pooling across vendors blurs the very cross-vendor finding the matrix exists to surface; not used as a headline. Reported as a single-number summary only. |
| Turn budget | `max_turns = 8` | AgentLAB default; matches T3 / T3e horizon |
| AgentLAB judge | `eu.anthropic.claude-sonnet-4-6` (temperature=0) | Replaces paper's GPT-4.1 judge; cross-judge sensitivity check is a stretch follow-up |
| dredd judge model | `eu.anthropic.claude-sonnet-4-6` via Bedrock | Production-recommended; matches Test 23 |
| dredd judge prompt | prompt v2 (`B7.1`) | Production prompt |
| Embedding | `eu.cohere.embed-v4:0` via Bedrock | Same as Test 23 |
| Thresholds | `deny=0.15`, `review=0.60` | Production calibration |
| Bedrock regions | Anthropic agents `eu-west-1`; Qwen agents `eu-central-1`; judge `eu-central-1` (cross-region for Anthropic agents) | Matches Test 23 region split |

**Total runs:** 7 agents × 2 arms × 10 scenarios = **140 trajectories**. AgentLAB-judge invocations: 140 (one per trajectory). dredd-judge invocations under the defended arm: ~70 trajectories × ~5 PreToolUse calls/trajectory ≈ 350.

## Hypotheses

**H1 --- Anthropic baselines are non-zero on AgentLAB (unlike T3e where they're at the floor).** AgentLAB's attack-type taxonomy includes *memory poisoning* and *objective drifting*, which target structurally different surfaces from the T3 user-turn-reframing pretext that current Anthropic models have been trained to refuse. Predicted: Sonnet 4.6 + Opus 4.7 baseline aggregate ASR 10--40\% on AgentLAB (vs. 0\% on T3e). Confirms that Test 19's floor is attack-class-specific, not a general Claude-refuses-everything property.

**H2 --- Bedrock-Qwen baselines are high, tracking Test 23's T3e pattern.** Per attack type Qwen baseline ASR ${\geq}30$\% on intent hijacking / tool chaining / task injection / objective drifting; ${\geq}50$\% on memory poisoning (the unprotected axis). Aggregate Qwen baseline ASR 40--70\%. Wider than T3e because AgentLAB's mutable-environment design exposes the agent to attack vectors beyond user-turn reframing.

**H3 --- Defence reduces ASR materially on the four agentic attack types but NOT on memory poisoning.** dredd's PreToolUse gate sees the tool-call-vs-task surface; intent hijacking + tool chaining + task injection + objective drifting all express as off-task tool calls. **Memory poisoning manipulates intra-session mutable state (file system / DB / browser cookies / app state written in earlier turns and read in later turns of the same trajectory)** which the gate cannot see — the malicious *write* may be on-task-plausible and the malicious *read* indistinguishable from a benign read at the call-surface level. Predicted: defended ASR drops $\ge 50$\% (relative) on the four agentic types; memory poisoning ASR is approximately unchanged between arms. **Pre-flight verification (added per review question 1):** confirm in stage-1 pilot that AgentLAB's memory-poisoning scenarios are intra-session (poison + exploit within the same 8-turn trajectory) rather than cross-session (poison in trajectory $i$, exploit in $i{+}1$). If cross-session, the planned per-trajectory container-isolation design kills the attack by construction and any 0\% defended ASR is an artefact rather than a defence finding — the plan needs a state-persistence harness or AgentLAB's own multi-session driver.

**H4 --- Per-attack-type defence-effect ordering matches the attack's tool-call-surface visibility.** Predicted ordering by relative ASR drop (largest defence effect first): intent hijacking $\approx$ task injection $>$ tool chaining $>$ objective drifting $>$ memory poisoning (≈0). **Directional only at smoke scale (per review question 5):** at $N=2$ per (agent, attack-type) cell and $N=14$ pooled across all 7 agents per attack type, Wilson 95\% CI half-width is ~26\,pp — H4's ordering is not strictly testable here unless adjacent-tier differences exceed ~50\,pp. Acknowledge as directional-evidence-for-future-$N=60$+-work.

**H5 --- Cross-vendor direction matches §3.6 / §3.7.** Anthropic baselines lower than Qwen baselines on the four agentic types (per H1 + H2); defence drops both vendor families by similar relative amounts on the agentic types. Confirms the cross-vendor finding generalises to a third attack-class corpus.

**H6 --- Memory-poisoning ASR is high across vendors at baseline.** Both Anthropic and Qwen baseline memory-poisoning ASR ${\geq}40$\%. Memory poisoning exploits persisted state, which neither vendor's training has been adversarially calibrated against (per public model cards). Useful evidence point for the §4.6 "structurally out-of-scope" framing.

## Success criteria

1. **Provenance fields populated** on every trajectory JSON: `agent.provider`, `agent.model`, `agent.region`, `agentlab.scenario_id`, `agentlab.attack_type`, `agentlab.environment`, `defence.arm`, `judge.agentlab.model`, `judge.agentlab.label`, `judge.agentlab.reason`, `dredd.judge.model`, `dredd.judge.prompt=v2`, `dredd.thresholds`, `run.timestamp`, `agentlab.commit_hash` (pin AgentLAB to specific commit).
2. **Pilot gate cleared.** $N=10$ Sonnet 4.6 baseline pilot produces a non-degenerate ASR distribution (not stuck at 0\% or 100\% across all 10 trajectories) and zero tool-API or environment-routing errors.
3. **Wilson 95\% CI half-widths reported.** $N=10$ per cell gives ~26\,pp half-width — explicitly noted as smoke-level. Per-attack-type within a cell ($N=2$): ~52\,pp, not informative individually. Per-attack-type pooled across agents within one arm ($N=14$): ~26\,pp; informative only for rough cross-attack-type direction.
4. **Defence pipeline configuration identical to Test 23** (per review question 8 correction). Same Sonnet 4.6 judge, prompt v2, Cohere v4, threshold calibration. New code is limited to (a) the AgentLAB scenario driver, (b) the FastAPI bridge that routes AgentLAB's tool calls through dredd's PreToolUse hook, and (c) the stratified scenario sampler.
5. **Per-trajectory dredd judge verdicts captured.** Diagnostic for H3 / H4 — particularly to confirm that memory-poisoning trajectories pass through the dredd gate without flagging (because nothing on the tool-call surface reveals the attack).
6. **Memory-poisoning state model verified intra-session** in stage-1 pilot (per review question 1). If verified cross-session, halt and reconsider isolation design.
7. **Cross-judge sensitivity check during pilot, not after** (per review question 4). Dual-grade the 10 stage-2 pilot trajectories with both Sonnet 4.6 and GPT-4.1 (or GPT-4o-mini as cheaper proxy); if the two judges disagree on $\ge 3$ of 10 labels, halt and diagnose before scaling to the full matrix.
8. **Stratified sampler enforces environment diversity** (per review question 7). The 2 scenarios per attack type are drawn from $\ge 2$ distinct AgentLAB environments where possible; if a given (attack-type) only has scenarios in one environment, accept and note it.

## Decision rules

**If H1 + H2 + H3 + H5 hold (Anthropic non-zero baseline; Qwen high baseline; defence drops 4 of 5 attack types; cross-vendor direction stable):**
- Add **§3.9 AgentLAB Long-Horizon Cross-Vendor Smoke** (~half page, smaller than §3.6 / §3.8 because of $N=10$). Headline table: 7 agents × 2 arms × per-attack-type ASR. Combined with §3.6 (T3e) and §3.7 (AgentDojo), produces three-corpus cross-vendor coverage on overlapping but distinct attack classes.
- **§4.5 Limitations:** explicit "memory poisoning is structurally out of scope" sentence with empirical AgentLAB evidence point. Cleaner than Test 24's MT-AgentRisk-only framing.
- **§4.6 Future Work:** AgentLAB demoted from "missing third corpus" to "smoke-validated; full $N=60$+ replication is future work."

**If H1 fails low (Anthropic baseline still at floor across all 5 attack types):**
- Anthropic's training generalises beyond T3-class user-turn reframing to the broader AgentLAB attack distribution. Strengthens the §4.5 "Anthropic floor" framing. Worth a paragraph noting the surprise finding.

**If H3 fails (defence drops memory-poisoning ASR meaningfully):**
- Unexpected. Inspect dredd judge verdicts: most likely the persisted-state attack writes a file or state-mutation call that the judge does flag (because the *write* is on-task-suspicious even if the *future read* is what does the harm). Refined characterisation is useful for §4.6 — the boundary is fuzzier than the structural argument suggests.

**If H6 fails (memory-poisoning baseline ASR low across vendors):**
- The benchmark's memory-poisoning attack is weaker than expected. Possible causes: AgentLAB's persisted-state model doesn't cleanly translate to dredd's FastAPI tool sandbox; trajectories don't reach the second-session re-read step within `max_turns=8`. Worth halting and diagnosing rather than reporting.

**If pilot gate fails (degenerate ASR or tool-API errors):**
- Halt. Diagnose FastAPI bridge or scenario-loader bugs. Do not scale to other agents.

## Execution

### Engineering required

AgentLAB has a published GitHub release with FastAPI + Ray scripts (per source-paper abstract). Engineering reuses the Bedrock-agent invocation paths from Test 23.

| Engineering item | Effort |
|---|---|
| Verify AgentLAB GitHub release is publicly accessible (not gated like MT-AgentRisk's HF dataset) and pin to specific commit hash. Clone to a standardised path (`/opt/agentlab`, not `/tmp/agentlab`) baked into the Dockerfile (per review question 9) | ~30 min |
| `fargate/docker-entrypoint-test25.sh` (per review question 6). Mirrors the Test 20 / 21 entrypoint pattern with AgentLAB-specific env vars (`AGENTLAB_PATH=/opt/agentlab`, `AGENTLAB_COMMIT`, attack-type list) | ~2 hours |
| `src/runner-agentlab.ts` — loads stratified 10-scenario subset across 5 attack types, drives multi-turn loop per scenario, dispatches each tool call through dredd's PreToolUse hook (defended arm) or directly to AgentLAB's FastAPI tool sandbox (baseline arm), captures full transcript, calls AgentLAB judge | ~3--4 days |
| FastAPI bridge: AgentLAB ships its own FastAPI tool wrappers; integration is wrapping these so that the Bedrock agent's tool calls route through dredd's PreToolUse hook before reaching FastAPI | ~2 days |
| Bedrock executor reuse: `executor-bedrock.ts` (Anthropic) and `executor-bedrock-qwen.ts` (Qwen, from Test 23) drive the agent unchanged. Need wrapper to expose them as AgentLAB-FastAPI-compatible chat clients | ~1 day |
| AgentLAB judge bridge — invokes Sonnet 4.6 with AgentLAB classification prompt at temp=0; parses succeeded / refused / failed label + reason | ~half day |
| Stratified scenario sampler with seeded RNG (deterministic 2-per-attack-type selection) **+ environment-diversity constraint** (per review question 7): the 2 scenarios per attack type drawn from $\ge 2$ distinct AgentLAB environments where the attack-type catalogue spans more than one environment. Falls through to "accept single-environment" if the attack type is environment-locked, with a provenance flag | ~1 day |
| Persistent state isolation between trajectories — critical for memory-poisoning scenarios so attack state from trajectory $i$ doesn't bleed into trajectory $i{+}1$ | ~half day |
| Pilot gate harness — 10-scenario Sonnet 4.6 baseline pilot with degenerate-ASR check | ~1--2 hours |

**Total engineering: ~1--1.5 weeks.** Less than Test 24's ~1.5--2 weeks because AgentLAB ships its own FastAPI tool wrappers; only the bridge layer to dredd is new. Reusable for future $N=60$+ AgentLAB replication if the smoke results merit scaling.

### Command

```bash
# Pilot — 10 stratified scenarios on Sonnet 4.6 baseline only, gates the matrix
AWS_REGION=eu-west-1 CLAUDE_CODE_USE_BEDROCK=1 \
  npx tsx src/runner-agentlab.ts \
    --models claude-sonnet-4-6 \
    --scenarios stratified-10 \
    --attack-types intent_hijacking,tool_chaining,task_injection,objective_drifting,memory_poisoning \
    --random-seed 27 \
    --defences none \
    --max-turns 8 \
    --benchmark-judge-model eu.anthropic.claude-sonnet-4-6 \
    --benchmark-judge-temperature 0 \
    --agentlab-commit "$(git -C /opt/agentlab rev-parse HEAD)" \
    --output-dir results/test25-pilot/

# Anthropic agents (Bedrock eu-west-1)
AWS_REGION=eu-west-1 CLAUDE_CODE_USE_BEDROCK=1 \
JUDGE_BEDROCK_REGION=eu-central-1 \
  npx tsx src/runner-agentlab.ts \
    --models claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-6,claude-opus-4-7 \
    --scenarios stratified-10 \
    --random-seed 27 \
    --defences none,intent-tracker \
    --max-turns 8 \
    --benchmark-judge-model eu.anthropic.claude-sonnet-4-6 \
    --dredd-judge-model eu.anthropic.claude-sonnet-4-6 \
    --dredd-judge-prompt B7.1 \
    --embed-model eu.cohere.embed-v4:0 \
    --output-dir results/test25/anthropic/

# Qwen agents (Bedrock eu-central-1)
AWS_REGION=eu-central-1 CLAUDE_CODE_USE_BEDROCK=1 \
JUDGE_BEDROCK_REGION=eu-central-1 \
  npx tsx src/runner-agentlab.ts \
    --models qwen.qwen3-32b-v1:0,qwen.qwen3-235b-a22b-2507-v1:0,qwen.qwen3-coder-30b-v1:0 \
    --backend bedrock-qwen \
    --scenarios stratified-10 \
    --random-seed 27 \
    --defences none,intent-tracker \
    --max-turns 8 \
    --benchmark-judge-model eu.anthropic.claude-sonnet-4-6 \
    --dredd-judge-model eu.anthropic.claude-sonnet-4-6 \
    --dredd-judge-prompt B7.1 \
    --embed-model eu.cohere.embed-v4:0 \
    --output-dir results/test25/qwen/
```

### Wall-clock and cost

**Per (agent × arm) cell ($N=10$ trajectories, ~10 LLM-calls/trajectory):**

| Defended agent | Per-trajectory cost | Cell cost ($N=10$) | Wall-clock |
|---|---:|---:|---:|
| Haiku 4.5 baseline | agent ~\$0.005 + AgentLAB judge ~\$0.04 | **~\$0.45** | ~30 min |
| Haiku 4.5 defended | + dredd judge ~\$0.20 | **~\$2.50** | ~40 min |
| Sonnet 4.6 baseline | agent ~\$0.04 + judge ~\$0.04 | **~\$0.80** | ~40 min |
| Sonnet 4.6 defended | + dredd judge ~\$0.20 | **~\$2.85** | ~50 min |
| Opus 4.6 baseline | agent ~\$0.06 + judge ~\$0.04 | **~\$1.00** | ~45 min |
| Opus 4.6 defended | + dredd judge ~\$0.20 | **~\$3.05** | ~55 min |
| Opus 4.7 baseline | agent ~\$0.06 + judge ~\$0.04 | **~\$1.00** | ~45 min |
| Opus 4.7 defended | + dredd judge ~\$0.20 | **~\$3.05** | ~55 min |
| Qwen3 32B baseline | agent ~\$0.02 + judge ~\$0.04 | **~\$0.60** | ~35 min |
| Qwen3 32B defended | + dredd judge ~\$0.20 | **~\$2.65** | ~50 min |
| Qwen3 235B baseline | agent ~\$0.03 + judge ~\$0.04 | **~\$0.70** | ~40 min |
| Qwen3 235B defended | + dredd judge ~\$0.20 | **~\$2.75** | ~55 min |
| Qwen3 Coder 30B baseline | agent ~\$0.04 + judge ~\$0.04 | **~\$0.80** | ~40 min |
| Qwen3 Coder 30B defended | + dredd judge ~\$0.20 | **~\$2.85** | ~50 min |
| **Sub-total (agent + judges)** | | **~\$25** | |
| Embedding (~\$0.04 × 7 defended cells) | | **~\$0.30** | |
| **Total** | | **~\$25** | |

**Wall-clock:** ~10--12h serial. With three parallel lanes (Anthropic `eu-west-1`, Qwen `eu-central-1`, AgentLAB judge cross-region): **~4--6h**.

**Budget cap:** \$60 all-in. Halt at \$80; report partial matrix.

### Pilot before full run

Three-stage gate:

1. **Engineering smoke + memory-poisoning state-model check** (~30 min, ~\$0.50): AgentLAB FastAPI server up; one hand-picked trajectory completes end-to-end on Sonnet 4.6 baseline; AgentLAB judge returns a label. **Additionally inspect a memory-poisoning scenario JSON (per review question 1):** confirm whether the attack writes-then-reads within an 8-turn trajectory (intra-session, plan proceeds) or expects re-invocation (cross-session, halt and rework state-isolation harness).
2. **10-scenario pilot + dual-judge cross-validation** (~50 min, ~\$2.50): Sonnet 4.6 baseline only, 10 stratified scenarios with seed=27. Verify (a) no tool-API errors, (b) ASR is not degenerate (not 0/10 or 10/10 across all attack types), (c) at least one of the five attack types lands a baseline success (so the matrix has signal). **Also dual-grade the 10 transcripts with GPT-4o-mini as a cheap proxy for the source paper's GPT-4.1 judge (per review question 4); if disagreement $\ge 3$ of 10 labels, halt and diagnose before scaling.**
3. **One-agent matrix pilot** (~1.5h, ~\$4): Sonnet 4.6 × 10 scenarios × both arms. Validates the full pipeline end-to-end and gives a first defence-effect signal on the most paper-comparable agent. If H1 fails (still 0\% baseline) here, halt and reconsider whether AgentLAB's attack types actually transfer to current Anthropic frontier — possible result; would reframe the test rather than scrap it.

### Paper integration (if H1 + H3 + H5 hold)

**New §3.9 AgentLAB: Long-Horizon Cross-Vendor Smoke** (~half page):

```
Table — AgentLAB ASR by attack type, smoke-scale (N=10 per cell)

Defended agent     | Hijack | Chain | Inject | Drift | Mem.Poison | Aggregate
-------------------|--------|-------|--------|-------|------------|----------
Haiku 4.5 base     | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Haiku 4.5 defend   | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Sonnet 4.6 base    | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Sonnet 4.6 defend  | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Opus 4.6 base      | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Opus 4.6 defend    | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Opus 4.7 base      | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Opus 4.7 defend    | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Qwen3 32B base     | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Qwen3 32B defend   | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Qwen3 235B base    | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Qwen3 235B defend  | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Qwen3 Coder base   | X%     | X%    | X%     | X%    | X%         | X% [a, b]
Qwen3 Coder defend | X%     | X%    | X%     | X%    | X%         | X% [a, b]

Wilson 95% CI half-width: ~26 pp per cell, ~12 pp all-agent pooled aggregate (blurs cross-vendor)
```

Headline framing: ``On AgentLAB's four PreToolUse-visible attack types the dredd defence drops ASR from $X$\% to $Y$\%; on the memory-poisoning class --- which manipulates persisted environment state and is not visible at the tool-call surface --- the defence has no measurable effect, as predicted by the gate's structural design. This is honest scope-boundary disclosure (§\ref{sec:future_work}) rather than a defence failure.''

**§4.5 Limitations:** memory-poisoning row promoted from ``per the AgentLAB taxonomy [citation]'' framing in Table~\ref{tab:runtime-interception-family} to direct empirical evidence: ``We confirm this empirically: dredd's defence has no measurable effect on AgentLAB's memory-poisoning attack class ($\Delta_\text{ASR} = X$\,pp, Wilson 95\% CI [a, b] containing zero).''

**§4.6 Future Work:** AgentLAB at $N=60$+ for tighter per-attack-type CIs.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AgentLAB GitHub release is gated or otherwise inaccessible (analogous to MT-AgentRisk's HF gate) | Low--Medium | High | Verify access in stage-0 of the pilot before any engineering investment. If gated, escalate or defer to MT-AgentRisk-on-HF-access route |
| FastAPI tool-sandbox bridge to dredd PreToolUse hook produces different agent behaviour from Test 23's executor-bedrock direct mode | Medium | High | Pilot stage 1 catches this; cross-check on a single Sonnet 4.6 trajectory that the run log matches the executor-bedrock direct-mode baseline |
| Memory-poisoning persistent-state isolation leaks between trajectories | Medium | Medium | Containerised isolation; each trajectory gets a fresh AgentLAB FastAPI container; verify in stage-1 pilot |
| AgentLAB judge (Sonnet 4.6) labels divergently from source paper's GPT-4.1 judge | Medium | Medium | Cross-judge sensitivity check on 30 trajectories (stretch follow-up); if material divergence, run dual judges as headline |
| $N=10$ per cell is too small to distinguish defence effect from noise on attack types where baseline ASR is 30--50\% | High | Low (smoke scope) | Plan acknowledges smoke-only; per-attack-type CIs are wide (~26\,pp); all-agent pooled aggregate CIs at ~12\,pp are usable but blur cross-vendor; full $N=60$+ replication is the stretch target |
| Cost overrun on Opus 4.6 / 4.7 / Qwen 235B on long-horizon trajectories | Low | Low | Budget cap \$80; per-cell halt-on-overrun; can drop the most expensive agents and report 4--5-agent table if cost runs hot |
| H6 fails (memory-poisoning baseline ASR low across all vendors) | Medium | Medium | If diagnostic shows AgentLAB's memory-poisoning trajectories don't reach the second-session re-read step within `max_turns=8`, increase to `max_turns=12` and re-run pilot before scaling |
| AgentLAB version drift (paper updates the benchmark mid-experiment) | Low | Low | Pin to specific commit hash; record in provenance |

## Non-goals

- **Full $N=60$+ replication.** Smoke-scale only. Full replication is future work conditional on smoke results justifying the engineering / compute investment.
- **OpenAI agents (GPT-4o-mini / GPT-4o).** Out of scope for this matrix because they're not on Bedrock; the Test 23 plan also excluded them on this axis. Future work via the generic-OpenAI executor (Test 24's deferred engineering item).
- **Cross-judge ensemble for headline numbers.** Single-judge (Sonnet 4.6); cross-judge sensitivity check is a stretch follow-up.
- **Per-environment breakdown** (AgentLAB has 28 environments). The 5-attack-type breakdown is informative enough at $N=10$; per-environment $N=2$ is too noisy.
- **Stop-hook prototype.** Same as Test 23/Test 24: superseded; cross-vendor evidence on PreToolUse pipeline only.
- **Reasoning-effort sweep** / **Prompt-variant ablation** / **Sonnet 4.6 / Opus 4.7 re-runs of Test 23 cells.** Same as Test 23/Test 24 conventions.
- **MT-AgentRisk integration.** Test 24 — separate plan, blocked on HF gate.
- **Custom AgentLAB scenarios.** Use only the public 644-test split, sampled stratified.

## Dependencies

- **Reuses dredd PreToolUse pipeline** unchanged from Test 23.
- **Reuses Bedrock executor wrappers** from Test 23 (`executor-bedrock.ts` for Anthropic, `executor-bedrock-qwen.ts` for Qwen). New code is the AgentLAB FastAPI bridge.
- **AgentLAB GitHub release** must be publicly accessible. Stage-0 verify.
- **Citation already verified:** arXiv:2602.16901 BibTeX entry `jiang2026agentlab` already in `p15.bib`.
- **Independent of Tests 19--24.** Different attack-class corpus.

## Stretch follow-ups

If Test 25 lands cleanly:

1. **Cross-judge sensitivity.** Re-grade 30 random trajectories with GPT-4.1 (source paper's judge); report inter-judge agreement κ. Confirms or refutes "judge model invariance" assumption. ~\$5 additional cost.
2. **Scale to $N=60$ per cell** ($840$ trajectories total, ~\$150). Tightens per-cell CI half-width from ~30\,pp to ~13\,pp; per-attack-type from ~26\,pp to ~11\,pp. Required for a publishable headline-level cross-vendor matrix.
3. **Add OpenAI agents** (GPT-4o-mini + GPT-4o) once the generic-OpenAI executor exists. Closes the cross-vendor coverage to symmetrically include all three vendors on three corpora (T3e + AgentDojo + AgentLAB).
4. **Per-environment breakdown** within attack types if the smoke data shows large environment-to-environment variance.
5. **Adversarial / adaptive replay.** AgentLAB's adaptive-attack property (the attacker plan changes based on agent responses) can be evaluated against dredd by running the same scenario seeds with seed-replay vs. live-adaptation; if defence effect differs, adversarial-adaptation is a measurable defence-stress axis.

These are stretch goals, not part of Test 25 proper.

## Compared to Test 24 (MT-AgentRisk)

| | Test 24 (MT-AgentRisk) | Test 25 (AgentLAB) |
|---|---|---|
| Status | Blocked on HF gate | Drafted, ready to engineer |
| Public access | Gated dataset | GitHub-released (verify in stage-0) |
| Scope | 365 scenarios, 5 tool surfaces | 644 scenarios, 28 environments, 5 attack types |
| Engineering | ~1.5--2 weeks | ~1--1.5 weeks |
| Smoke cost | ~\$343 (full matrix) | **~\$25 ($N=10$ smoke)** |
| Defended agents | 5 (Haiku, Sonnet, Opus 4.7, GPT-4o-mini, **Qwen Coder 480B-A35B** — Test 24's planned set, includes a Qwen variant not yet tested elsewhere) | **7 (4 Anthropic + 3 Qwen — `qwen.qwen3-32b-v1:0`, `qwen.qwen3-235b-a22b-2507-v1:0`, `qwen.qwen3-coder-30b-v1:0`; the already-tested set from Test 23, intentionally smaller-tier Qwen Coder than Test 24's planned 480B-A35B; per review question 3)** |
| Memory-poisoning evidence | No | **Yes (5 attack types include it)** |
| Adaptive-attack evidence | No | Partial (AgentLAB's attack plans are adaptive) |

**Sequencing:** if HF access for MT-AgentRisk lands before Test 25 engineering, run Test 24 first. Otherwise Test 25 is the higher-value next step at lower cost and the same engineering reuse for any future AgentLAB-or-MT-AgentRisk full-scale runs.

## Review questions (2026-04-27)

**Status:** All 9 addressed in the plan above. Each question's resolution is cross-referenced inline (search "per review question N"). This list is retained as an audit trail.


1. **Memory-poisoning state model: intra-session or cross-session?** The plan frames memory poisoning as manipulating "persisted environment state" and isolates trajectories with fresh containers. If the attack requires cross-session persistence (poison in trajectory $i$, exploit in trajectory $i{+}1$), the isolation design kills it by construction and any 0% ASR is an artefact. If it works within a single 8-turn trajectory (poison then read in the same session), the "persisted state" framing throughout H3, H6, and the §4.5 text needs tightening to "intra-session mutable state." Clarify the attack's state model before engineering.

2. **~14pp "per row aggregate" CI half-width doesn't match N=10.** Wilson 95% CI at $p=0.5$ with $N=10$ gives half-width ~26pp, not ~14pp. The plan correctly states ~30pp per cell elsewhere (same $N$). Does "row aggregate" mean pooling across all 7 agents for a single arm ($N=70$)? If so, that's an unusual aggregation that blurs cross-vendor differences. Clarify the intended aggregation and fix the CI figure.

3. **Qwen model mismatch in comparison table.** Line 268 lists Test 24 as using "Qwen Coder 480B" but Test 25 uses "Qwen3 Coder 30B" (`qwen.qwen3-coder-30b-v1:0`). Is this intentional (different tests, different models) or a typo?

4. **Judge replacement validation timing.** The AgentLAB judge label is the headline ASR metric, but replacing GPT-4.1 with Sonnet 4.6 is only cross-validated in a stretch follow-up. Consider dual-grading ~10 pilot trajectories during the pilot stage to catch gross judge divergence before spending \$25 on the full matrix.

5. **H4 is unfalsifiable at smoke scale.** Per-attack-type $N=2$ per cell ($N=14$ across agents) with CIs of ~26pp cannot distinguish the predicted ordering unless differences exceed ~50pp. Acknowledge that H4 is directional for future $N=60$+ work, not testable here.

6. **No fargate entrypoint for Test 25.** Every other test has a `docker-entrypoint-testN.sh`. Will Test 25 run on the sandbox? If so, add the entrypoint to the engineering items. If local-only, note that.

7. **Stratified sampler environment diversity.** With 2 scenarios per attack type drawn from 644 across 28 environments, the seeded RNG could place both samples in the same environment. Consider adding an environment-diversity constraint (different environments for the two samples per attack type).

8. **"Defence bridge byte-identical to Test 23" (success criterion 4).** The new FastAPI bridge introduces a different I/O path that doesn't exist in Test 23. Rephrase to: "defence pipeline configuration identical to Test 23; new code is limited to the AgentLAB scenario driver and FastAPI bridge."

9. **Pilot command `--agentlab-commit` path assumption.** The command uses `git -C /tmp/agentlab rev-parse HEAD`, which assumes a specific clone location. The Dockerfile / sandbox engineering should standardise the clone path and pin it.
