# Test Requirements — AgentDojo against GPT-4o (defended by Judge Dredd)

**Date:** 2026-04-20
**Supersedes:** extends `test-plan-external-benchmarks-2026-04-19.md` §1 with a non-Anthropic defended-agent target. That plan evaluates Haiku 4.5 and Sonnet 4.6 only; this document specifies the GPT-4o addition.
**Status:** requirements — execution plan to follow once OpenAI API access and budget are authorised.
**Priority:** High — without a non-Anthropic defended agent, the AgentDojo result is unfalsifiable: Claude 3.5 Sonnet (2024-10-22) already shows 1.11% baseline ASR and Claude 4.x is likely in the same 0–5% regime, so a 100% defence catch rate has no attack-success headroom to be meaningful against.

---

## 1. Motivation

AgentDojo's published baseline ASR for the `important_instructions` attack (no defence) varies by ~50 pp across model families:

| Family | Worst-case baseline ASR | Judge Dredd defence headroom |
|---|---|---|
| GPT-4 (0125-preview) | **56.28%** | Large |
| GPT-4o (2024-05-13) | **47.69%** | Large |
| Claude 3.5 Sonnet (2024-06-20) | 33.86% | Moderate |
| Llama-3-70B | 25.60% | Moderate |
| Claude 3 Opus / 3.5 Sonnet (2024-10-22) | 11% / 1.1% | Minimal — baseline floor |

The paper currently evaluates only Claude 4.x family (Haiku 4.5, Sonnet 4.6, Opus 4.7) as the defended agent. If those models' undefended AgentDojo ASR is already near zero (consistent with the 3.5/3.7 Sonnet trend), a reviewer can legitimately claim that the paper's 100% catch rate reflects the underlying agent's inherent resistance, not the defence. Running GPT-4o-2024-05-13 as the defended agent converts a possibly-vacuous result (100% of ~5% baseline) into a substantive one (100% of ~48% baseline).

---

## 2. Functional requirements

### 2.1 Defended agents in scope

- **GPT-4o (gpt-4o-2024-05-13)** — primary. Matches AgentDojo's published 47.69% baseline exactly; reproducibility of that baseline is the gating check.
- **GPT-4o-mini (gpt-4o-mini-2024-07-18)** — secondary. Cheaper variant; AgentDojo reports ~53% baseline ASR in follow-up work. Adds a cost-comparable point without doubling OpenAI spend.
- **Llama-3-70B-chat** — tertiary, conditional on bandwidth. 25.60% baseline ASR, exercises the "strong open-weight model" axis. Deferred unless the GPT-4o run completes under budget and ahead of schedule.

### 2.2 Defence configurations in scope

Mirror the 2026-04-19 plan's arm structure:

- **Baseline** — no Judge Dredd defence. Reproduces AgentDojo's published ASR; gating check.
- **Baseline prompt** — Judge Dredd active, baseline system prompt. Measures the pre-hardening defence.
- **B7.1** — Judge Dredd active, shipped production prompt. Main result.

No effort sweep on the judge side (the `test-plan-2026-04-18-opus-effort.md` data already shows minimal marginal value under B7.1). Judge model is **Claude Haiku 4.5 via Bedrock** — matches the paper's recommended pipeline and decouples the defended-agent axis from the judge-model axis.

### 2.3 AgentDojo scope

- All 4 tool suites: workspace, email, banking, travel.
- All 629 security test cases (full matrix).
- **Attack variant:** `important_instructions` only. It's the canonical attack with the published baseline that gate-checks our bridge; other variants are supplementary.
- **Benign task ASR baseline:** 97 benign user tasks × 1 rep per (agent, defence) cell, to measure whether the defence blocks legitimate workflows.

### 2.4 Integration

- AgentDojo integration via `agentdojo_defence_bridge.py` from the 2026-04-19 plan. Extend the bridge to accept an `--agent-provider {openai, anthropic, meta}` flag routing to the appropriate SDK.
- OpenAI path: `openai` Python SDK against `api.openai.com` with `OPENAI_API_KEY` in the Fargate secret store. Temperature 0, `max_tokens` matched to AgentDojo defaults (1024).
- Llama path (if run): Bedrock `meta.llama3-70b-instruct-v1:0` — no new provider onboarding required.
- Same HTTP bridge to `src/server.ts` for Judge Dredd evaluation; the defended-agent change does not affect the defence layer.

---

## 3. Non-functional requirements

### 3.1 Budget

| Item | Estimated cost | Notes |
|---|---|---|
| GPT-4o full matrix (629 security × 3 defence arms + 97 benign × 3) | ~$45–60 | @ $2.50 / 1M input, $10 / 1M output; AgentDojo scenarios average ~8–12 LLM calls per task, ~600 input / 150 output tokens per call |
| GPT-4o-mini (same matrix) | ~$6–10 | 20× cheaper per token |
| Llama-3-70B via Bedrock (same matrix) | ~$5–8 | Already provisioned; marginal |
| Judge-side (Haiku 4.5) | ~$3–5 | ~3,774 judge calls @ $0.80 / 1M input |
| **Total OpenAI + Bedrock** | **≤ $80** | Conservative upper bound |

Budget approval threshold: $100. Anything above requires re-scoping (e.g., reducing to a workspace-suite-only run at ~$15).

### 3.2 Wall-clock

- GPT-4o matrix: ~12–18 h Fargate (AgentDojo agent loops are serial by task; 726 runs × 30–90 s per scenario).
- GPT-4o-mini: ~10–15 h.
- Llama-3-70B: ~8–12 h.
- Run overnight after a daytime bridge smoke test.

### 3.3 Provenance

Every result JSON must carry:
- `build.gitSha` — Judge Dredd repository commit.
- `benchmark.gitSha` — AgentDojo commit pinned in `agentdojo_defence_bridge.py`.
- `agent.provider`, `agent.model`, `agent.apiVersion` — e.g., `{"provider": "openai", "model": "gpt-4o-2024-05-13", "apiVersion": "2024-11-20"}`.
- `judge.provider`, `judge.model`, `judge.prompt` — e.g., `{"provider": "bedrock", "model": "eu.anthropic.claude-haiku-4-5-20251001-v1:0", "prompt": "B7.1"}`.
- `run.timestamp`, `run.durationMs`, `run.bedrockRegion`.

This is non-negotiable — without it the results are not reproducible under Bedrock's silent-weight-update policy (already flagged as a Limitations item for Opus 4.7).

### 3.4 Isolation

- OpenAI API calls must use a dedicated key (not a shared team key). Rotate after the run so we can audit the request history.
- No payment method linked to personal accounts. Use the City St George's billing entity if possible; otherwise a throwaway OpenAI account with a $100 prepaid balance.
- Fargate task must not log full tool-call payloads to CloudWatch at INFO level — AgentDojo's canary credentials appear verbatim in injected instructions, and while they are synthetic, logging them to a shared log system would pollute the search index.

---

## 4. Acceptance criteria

### 4.1 Gating (must pass before running the full matrix)

1. **Baseline reproduction.** GPT-4o without Judge Dredd yields ASR within **±3 pp of 47.69%** on the workspace suite (the suite AgentDojo's leaderboard primarily reports). Failure means the bridge is broken; do not run the defended arms.
2. **Benign utility reproduction.** GPT-4o without Judge Dredd achieves benign task completion within **±5 pp** of AgentDojo's published 69% benign utility. Failure means the scenario harness is misconfigured.
3. **Smoke test.** 10 security cases and 5 benign cases run end-to-end against each (agent, defence) cell with no exceptions, correct schema, and provenance fields populated.

### 4.2 Primary result — publishable

**B7.1 on GPT-4o reduces AgentDojo ASR by ≥ 30 pp with no more than 10 pp drop in benign utility.**

This threshold is chosen to be (a) unambiguously larger than AgentDojo's own reference defence `tool_filter` (~17 pp reduction), (b) meaningful against the 47.69% baseline (a drop to ≤17.69% is a real claim), and (c) still leaving the agent useful (benign utility ≥ 59%).

### 4.3 Secondary results — reportable

- **Baseline prompt vs B7.1 delta on AgentDojo.** Expected to match the ~30+ pp gain seen on the paper's own 12-case set. If smaller, the external-benchmark framing needs honest discussion (prompt may be overfitted to researcher-authored attacks).
- **GPT-4o-mini + B7.1 vs GPT-4o + B7.1.** Expected: similar catch rate if B7.1 generalises; divergent if the judge's signal depends on the defended agent's own refusal behaviour.
- **Judge false-positive rate on benign tasks.** Expected: ≤ 3% across the 97 benign tasks (binomial 95% upper bound from the paper's current N=100 FPR is ~3%).

### 4.4 Negative outcomes — what disconfirms

- **B7.1 ASR > 30% on GPT-4o.** The hardened prompt does not generalise; the paper's production recommendation is conditional on the Anthropic defended agent. Reportable honestly but changes the headline.
- **B7.1 FPR > 10% on AgentDojo benign tasks.** The euphemism detector is over-triggering in the AgentDojo workspace / email domain. Would require a prompt revision (B7.2) before the paper can recommend B7.1 unconditionally.
- **Baseline reproduction fails.** Indicates a bridge defect, not a defence finding. Do not publish any numbers from the run until reproduction passes.

---

## 5. Out of scope

- AgentDojo attacks other than `important_instructions`. The paper is about credential-exfil / goal-hijacking defence; AgentDojo's other attack types (prompt confusion, tool-poisoning) are different threat models. Report as future work.
- Non-English AgentDojo translations. English only.
- Azure OpenAI as a provider. OpenAI direct API is simpler and AgentDojo upstream uses it; Azure adds a routing layer with no benefit at this scale.
- Adaptive attacks (jailbreak search against our judge). Separate threat-model analysis; AgentDojo's attacks are fixed.
- Gemini / Mistral / Cohere defended agents. Budget-constrained; can be added in a follow-up if the OpenAI result is positive.
- Re-running the Claude 4.x evaluation from `test-plan-external-benchmarks-2026-04-19.md`. That plan still stands; this is additive.

---

## 6. Dependencies

- **Upstream (this blocks on):**
  - `agentdojo_defence_bridge.py` functional from 2026-04-19 plan. Status at time of writing: specified but not yet implemented.
  - OpenAI API access for the research account (signup + payment method).
  - Fargate task configuration updated for `OPENAI_API_KEY` secret injection.
- **Downstream (blocks on this):**
  - Paper §6.X "External Validation" subsection in `p15.tex`. Expects one AgentDojo table with Anthropic and OpenAI rows side-by-side.
  - Paper §7.3 Limitations update: removal of the "test set scope" caveat if acceptance criterion 4.2 passes.

---

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bridge routes GPT-4o responses incorrectly (e.g., tool-call JSON differs from AgentDojo's expected Anthropic-style) | Medium | High | AgentDojo upstream has an OpenAI adapter; use it directly rather than writing a new one. Smoke test is explicitly for this. |
| OpenAI rate limits throttle the run below overnight completion | Medium | Medium | Default rate for a new account is 10k RPM / 30M TPM. Should be sufficient. If hit, set `--parallel 4` in AgentDojo runner. |
| OpenAI model silently updated (like Bedrock) and baseline drifts | Low | Medium | Pin to the dated variant `gpt-4o-2024-05-13` explicitly, not the rolling `gpt-4o`. Record response header `openai-model` for audit. |
| Cost overrun — AgentDojo scenarios consume more tokens than estimated | Low-Medium | Low | Budget cap of $100 in the OpenAI account settings. Halt on breach. |
| Benign-utility drop > 10 pp (acceptance criterion 4.2 fails on the benign axis even if ASR criterion passes) | Medium | Medium | Before drafting paper copy, check benign utility first. If degraded, the defence is not free — reframe the recommendation as "ASR reduction at cost of X% utility". |
| GPT-4o's refusal behaviour interferes with AgentDojo's benign tasks independently of our defence | Low | Low | Baseline arm (no defence) measures this; difference between baseline and defended isolates our contribution. |

---

## 8. Execution order (outline — full plan in a follow-up doc)

```
Day 1 AM   OpenAI account + API key + payment method + budget cap.
           Extend agentdojo_defence_bridge.py with --agent-provider routing.
Day 1 PM   Smoke test: 10 security + 5 benign on GPT-4o with each defence arm.
           Validate provenance fields and schema. Check gating criteria §4.1.
Day 2 AM   Launch full GPT-4o matrix (~14 h Fargate overnight).
Day 2 PM   Launch GPT-4o-mini matrix in parallel (separate Fargate task).
Day 3 AM   Collect results. Run acceptance checks §4.2–§4.4.
Day 3 PM   Optional Llama-3-70B run if budget and wall-clock remain.
           Result aggregation + table generation for paper.
Day 4      Paper revision (§6.X External Validation) + commit.
```

---

## 9. Reporting

Results to:
1. `results/agentdojo-gpt4o-<timestamp>/` — per-case JSONs with provenance.
2. `docs/agentdojo-gpt4o-results-<date>.md` — summary with ASR, benign utility, FPR per (agent, defence) cell, plus Wilson 95% CIs on all rates.
3. `Adrian/p15/p15.tex` §6.X — main-body table (if acceptance passes).

No public GitHub push of raw AgentDojo responses until the AI-safety canary string handling is audit-cleared (see §4 of `test-plan-external-benchmarks-2026-04-19.md` for AgentHarm's equivalent concern; AgentDojo does not currently require this but the principle carries).

---

## 10. Open questions

- Does the paper's §6.9 cross-model evaluation treatment (Haiku / Sonnet / Opus 4.6 / Opus 4.7 as defended agents) get superseded by this work, or do both stay? Leaning toward both stay: §6.9 covers the Claude axis, new §6.X covers the cross-vendor axis. Confirm with co-author before drafting.
- Should the OpenAI run also include GPT-4-0125-preview for the highest-ASR baseline (56.28%)? Marginal cost, maximum rhetorical weight on the defence claim. Decision: yes if the GPT-4o run completes under budget; it is otherwise deferrable.
- Is there journal-side concern about mixing Anthropic and OpenAI in the same evaluation given the paper's submission venue (Springer Cybersecurity, single-blind, neither vendor has an editor-board conflict)? Expected answer: no — and this is independent of the technical plan.
