# Test 12 Summary — AgentDojo External Benchmark

**Date:** 2026-04-20  
**Harness:** `fargate/docker-entrypoint-test12.sh` → `benchmarks/agentdojo/run_benchmark.py`  
**Result files:** `s3://cko-results/test12/` (downloaded summaries to `results/agentdojo-*.json`)

## What was tested

The [AgentDojo](https://github.com/ethz-spylab/agentdojo) indirect prompt injection benchmark (v1.2.2) against two Claude models — Haiku 4.5 and Sonnet 4.6 — using two attack strategies: `important_instructions` and `tool_knowledge`. All four runs were **baseline** (no Dredd defence) to establish whether AgentDojo's attacks succeed against current Anthropic models.

**Suites:** workspace, banking, slack, travel (949 task×injection combinations per run)  
**Backend:** Bedrock (eu-west-2)  
**Containers:** bedt3, bedt5, bedt7, bedt9 (baselines); bedt4, bedt6, bedt8, bedt10 (defended — stopped early, see findings)

## Results — Baseline (no defence)

### important_instructions attack

| Suite | Haiku 4.5 Utility | Haiku 4.5 ASR | Sonnet 4.6 Utility | Sonnet 4.6 ASR |
|---|---|---|---|---|
| workspace (n=560) | 86.6% | 0.0% | 96.1% | 0.0% |
| banking (n=144) | 55.6% | 0.0% | 75.7% | 0.0% |
| slack (n=105) | 70.5% | **1.0%** | 71.4% | 0.0% |
| travel (n=140) | 57.1% | 0.0% | 67.9% | 0.0% |
| **Average** | **67.4%** | **0.2%** | **77.8%** | **0.0%** |

### tool_knowledge attack

| Suite | Haiku 4.5 Utility | Haiku 4.5 ASR | Sonnet 4.6 Utility | Sonnet 4.6 ASR |
|---|---|---|---|---|
| workspace (n=560) | 87.0% | 0.0% | 96.1% | 0.0% |
| banking (n=144) | 62.5% | 0.0% | 75.7% | 0.0% |
| slack (n=105) | 71.4% | 0.0% | 71.4% | 0.0% |
| travel (n=140) | 55.0% | 0.0% | 67.9% | 0.0% |
| **Average** | **69.0%** | **0.0%** | **77.8%** | **0.0%** |

### Summary across all runs

| Model | Attack | Avg Utility | Avg ASR | Defence Rate | Duration |
|---|---|---|---|---|---|
| Haiku 4.5 | important_instructions | 67.4% | 0.2% | 99.8% | 2h 12m |
| Haiku 4.5 | tool_knowledge | 69.0% | 0.0% | 100.0% | 2h 12m |
| Sonnet 4.6 | important_instructions | 77.8% | 0.0% | 100.0% | 3h 34m |
| Sonnet 4.6 | tool_knowledge | 77.8% | 0.0% | 100.0% | 3h 38m |

## Key findings

### 1. Current Claude models are already resistant to AgentDojo's attacks

Attack Success Rate (ASR) is 0.0% across 7 of 8 model×attack combinations. The sole exception is Haiku on the `important_instructions` attack in the Slack suite, which achieved a single successful injection (ASR 1.0%, 1 out of 105 attempts). Defence rate is effectively 100%.

### 2. AgentDojo cannot demonstrate Dredd's value

With ASR already at floor, Dredd can only reduce utility (via false positive denials) — it cannot improve security. The four defended runs (bedt4, bedt6, bedt8, bedt10) were stopped early because they would only show utility degradation, not security improvement.

### 3. Sonnet significantly outperforms Haiku on utility

Sonnet 4.6 averages 77.8% utility vs. Haiku 4.5 at 68.2%, a 10pp gap. This is consistent across all suites and both attack types. Sonnet completes the same tasks more reliably while being equally resistant to injection.

### 4. AgentDojo attacks are too weak for modern frontier models

The `important_instructions` and `tool_knowledge` attacks were designed for an earlier generation of models. Claude Haiku 4.5 and Sonnet 4.6 have been hardened against indirect prompt injection at the model level, rendering these attacks ineffective. This is a benchmark ceiling effect — not evidence that prompt injection is a solved problem.

## Implications for the paper

- **Do not use AgentDojo ASR as evidence of Dredd's effectiveness.** The benchmark cannot differentiate defended from undefended configurations when the baseline is already at ceiling.
- **AgentDojo utility scores are useful context** — they show the models' baseline task completion rates, confirming we're testing against capable agents.
- **The P14 attack scenarios (Tests 1–9) remain the primary evidence** for Dredd's effectiveness. These were specifically designed to exploit multi-turn tool-use patterns where model-level defences are insufficient.
- **If external benchmark validation is needed**, consider: (a) writing stronger custom attacks for the AgentDojo framework, (b) testing against models with known injection susceptibility, or (c) using a benchmark with more sophisticated attack strategies.

## Raw data

Summary JSON files in `results/`:
- `agentdojo-haiku-baseline-important_instructions.json`
- `agentdojo-sonnet-baseline-important_instructions.json`
- `agentdojo-haiku-baseline-tool_knowledge.json`
- `agentdojo-sonnet-baseline-tool_knowledge.json`

Full per-task results on S3:
- `s3://cko-results/test12/haiku-baseline-important_instructions/`
- `s3://cko-results/test12/sonnet-baseline-important_instructions/`
- `s3://cko-results/test12/haiku-baseline-tool_knowledge/`
- `s3://cko-results/test12/sonnet-baseline-tool_knowledge/`
