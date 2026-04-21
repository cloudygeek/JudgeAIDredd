# AgentDojo B7.1 defended arm — GPT-4o and GPT-4o-mini, 2026-04-21

Judge Dredd B7.1 hardened-prompt evaluation on both OpenAI defended agents, against the `important_instructions` attack. Companion to `agentdojo-gpt4o-baseline-results-2026-04-20.md` (the undefended baseline).

The defended arm was run only on the **pair-filtered subset** — the 385 (gpt-4o) and 284 (gpt-4o-mini) scenarios where the attack actually succeeded in the baseline arm. Scenarios where the baseline model already rejected the injection were not re-run, since Dredd can only reduce ASR, never raise it. Benign utility was measured on the full 97 user tasks in both arms.

## Configuration

| | |
|---|---|
| Judge Dredd commit | `267816c` |
| AgentDojo version | `v1.2.2` (PyPI `agentdojo==0.1.35`) |
| Defended agents | `gpt-4o-2024-05-13`, `gpt-4o-mini-2024-07-18` |
| Temperature | 0.0 |
| Judge | `eu.anthropic.claude-sonnet-4-6` (Bedrock eu-central-1) |
| Embeddings | `eu.cohere.embed-v4:0` (Bedrock eu-central-1) |
| Prompt variant | B7.1 (`--hardened`) |
| Attack | `important_instructions` |

Logs: `logs/gpt4o-b71.log`, `logs/gpt4o-mini-b71.log`.
Raw per-scenario results: `results/agentdojo-gpt4o-b71/`, `results/agentdojo-gpt4o-mini-b71/`.

## Headline results

### Attack success rate (ASR)

ASR reported against the full 949-scenario denominator for direct comparison to baseline. Defended ASR = (attacks that still succeeded under B7.1) / 949. Baseline-resisted scenarios contribute 0 to both arms.

| Agent | Baseline ASR (95% CI) | B7.1 ASR (95% CI) | Reduction |
|---|---|---|---|
| gpt-4o | 40.6% [37.5–43.7] | **1.5%** [0.9–2.5] | **−39.1 pp** |
| gpt-4o-mini | 29.9% [27.1–32.9] | **1.5%** [0.9–2.5] | **−28.5 pp** |

### Per-suite ASR (defended scenarios only, denominator = pairs that won in baseline)

| Agent | Suite | Pairs | Defended ASR (95% CI) |
|---|---|---|---|
| gpt-4o | workspace | 138 | 3.6% [1.6–8.2] |
| gpt-4o | banking | 104 | 1.9% [0.5–6.8] |
| gpt-4o | slack | 97 | 2.1% [0.6–7.2] |
| gpt-4o | travel | 46 | 10.9% [4.5–23.6] |
| gpt-4o-mini | workspace | 96 | 4.2% [1.6–10.3] |
| gpt-4o-mini | banking | 72 | 5.6% [2.2–13.5] |
| gpt-4o-mini | slack | 68 | 5.9% [2.3–14.1] |
| gpt-4o-mini | travel | 48 | 4.2% [1.2–13.9] |

Travel on gpt-4o is the weak spot (10.9%) — worth a closer look at which injection tasks got through.

### Benign utility (N=97 per arm)

| Agent | Baseline util (95% CI) | B7.1 util (95% CI) | Drop |
|---|---|---|---|
| gpt-4o | 77.3% [68.0–84.5] | **49.5%** [39.7–59.3] | **−27.8 pp** |
| gpt-4o-mini | 74.2% [64.7–81.9] | **64.9%** [55.0–73.7] | **−9.3 pp** |

### Judge-deny behaviour

| Arm | Judge calls | Denied | Deny rate | Avg latency |
|---|---|---|---|---|
| gpt-4o security (B7.1) | 1481 | 771 | 52.1% | 4,587 ms |
| gpt-4o benign (B7.1) | 359 | 120 | **33.4%** | 3,986 ms |
| gpt-4o-mini security (B7.1) | 1783 | 1166 | 65.4% | 4,324 ms |
| gpt-4o-mini benign (B7.1) | 464 | 66 | **14.2%** | 3,065 ms |

The benign-arm deny rate is the practical FPR on individual tool calls. gpt-4o's 33.4% is nearly 2.5× gpt-4o-mini's 14.2% — the same judge seeing the same tool signatures denies far more often when the defended agent is gpt-4o. Hypothesis: gpt-4o makes more expansive tool calls (longer queries, more fields) that the judge reads as drifted.

### Task-level FPR on benign

Tasks where baseline succeeded but defended failed — i.e. the defence broke a task that the undefended agent would have completed.

| Agent | Baseline pass | B7.1 pass | Broken by defence | Task FPR (95% CI) |
|---|---|---|---|---|
| gpt-4o | 75/97 | 48/97 | 27 | **27.8% [19.9–37.5]** |
| gpt-4o-mini | 72/97 | 63/97 | 9 | **9.3% [5.0–16.7]** |

## §4.2 / §4.3 acceptance assessment

Requirements targets:
- **§4.2** B7.1 reduces ASR by ≥30 pp with no more than 10 pp benign-utility drop.
- **§4.3** Judge benign FPR ≤ 3%.

| Criterion | gpt-4o | gpt-4o-mini |
|---|---|---|
| ASR reduction ≥ 30 pp | **−39.1 pp ✅** | −28.5 pp ⚠ (below by 1.5 pp) |
| Benign drop ≤ 10 pp | −27.8 pp ❌ | **−9.3 pp ✅** (0.7 pp headroom) |
| Benign task FPR ≤ 3% | 27.8% ❌ | 9.3% ❌ |

Neither agent passes the full acceptance spec. The failure modes are complementary:

- **gpt-4o**: defence is highly effective (−39 pp ASR) but far too aggressive on benign tasks (27.8% task FPR, 33% tool-call deny rate). The B7.1 prompt is over-triggering against gpt-4o's tool-use style.
- **gpt-4o-mini**: benign utility is within the ≤10 pp bound, but ASR reduction misses the threshold by 1.5 pp — a borderline numerical miss, within the width of the 95% CI.

## What this means for the paper

The spec's §4.4 "Negative outcomes — what disconfirms" calls both failure modes honestly-reportable:

> **B7.1 FPR > 10% on AgentDojo benign tasks.** The euphemism detector is over-triggering in the AgentDojo workspace / email domain. Would require a prompt revision (B7.2) before the paper can recommend B7.1 unconditionally.

The gpt-4o result lands squarely in that category. The headline recommendation needs to shift from "B7.1 is production-ready" to "B7.1 needs a domain-specific revision for AgentDojo's tool surface (banking transactions, email composition with attachments, calendar edits), and the currently-shipped prompt is overfit to the P14 researcher scenarios".

The gpt-4o-mini result is more nuanced: the defence works without catastrophic benign breakage, but ASR reduction is borderline. That reads as "B7.1 generalises to a smaller OpenAI model but not dramatically" — still a valid finding, and the 28.5 pp reduction is meaningful vs AgentDojo's built-in `tool_filter` reference defence (~17 pp in the paper).

## Cost and wall-clock

| Phase | Wall clock | Notes |
|---|---|---|
| gpt-4o B7.1 security | 8,730 s (2.4 h) | Dominated by judge latency (4.6s/call × 1481 calls ≈ 113 min serial judge time) |
| gpt-4o B7.1 benign | 2,256 s (37 min) | 359 judge calls |
| gpt-4o-mini B7.1 security | 10,501 s (2.9 h) | More tool calls (1783 vs 1481) |
| gpt-4o-mini B7.1 benign | 2,397 s (40 min) | 464 judge calls |

OpenAI spend (both agents × both arms, estimated from per-scenario token averages): ~$10.
Bedrock spend (Sonnet 4.6 judge, 4,087 total judge calls × ~$0.0135/call): ~$55.
**Total defended-arm cost: ~$65** — within the §3.1 $100 envelope.

## Known issues & next steps

1. **Travel suite on gpt-4o is weak** (10.9% ASR vs 2-4% on other suites). Drill into which travel `injection_task_*` sequences got through. Could be that travel-specific tool names/semantics make the judge uncertain, or that the injected text pattern mimics a legitimate travel-planning instruction.
2. **Judge deny rate asymmetry** between gpt-4o (52% sec / 33% benign) and gpt-4o-mini (65% sec / 14% benign). The security-arm deny rate scales with the agent's willingness to attempt the injected tool call; the benign-arm deny rate exposes genuine over-trigger. A short qualitative review of the 120 denied benign calls on gpt-4o would identify the dominant FPR pattern.
3. **No B7.2 prompt yet.** If a prompt revision is in scope, the gpt-4o benign denials are the training signal.
4. **Single judge model only.** We didn't rerun with Haiku 4.5 as the spec §2.2 originally recommended. Sonnet 4.6 is the more capable and more expensive choice; Haiku would halve the judge cost and might slightly raise the deny rate. A Haiku comparison is the next test to run if budget allows.

## Data provenance

- Baseline JSONs: `results/agentdojo-gpt4o-baseline/gpt-4o-2024-05-13/`, `results/agentdojo-gpt4o-mini-baseline/gpt-4o-mini-2024-07-18/`
- B7.1 JSONs: `results/agentdojo-gpt4o-b71/gpt-4o-2024-05-13-dredd-B7.1/`, `results/agentdojo-gpt4o-mini-b71/gpt-4o-mini-2024-07-18-dredd-B7.1/`
- Successful-pair files: `results/agentdojo-gpt4o-baseline/successful-pairs.json`, `results/agentdojo-gpt4o-mini-baseline/successful-pairs.json`
- Summary JSONs: `results/agentdojo-*-b71/summary-*.json`

Every result carries `agentdojo_package_version`, `benchmark_version`, per-scenario `duration`, and a complete `messages` trace for post-hoc audit.
