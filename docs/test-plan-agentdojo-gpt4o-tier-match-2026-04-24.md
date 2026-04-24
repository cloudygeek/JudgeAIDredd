# Test Plan — AgentDojo Re-run on GPT-4o (Tier-Matched Comparison to CaMeL)

**Date:** 2026-04-24
**Context:** P15 peer review item M2 (`Adrian/p15/PEER_REVIEW.md` 2026-04-24 third pass). §4.4 Table 24 of the paper compares this defence on GPT-4o-mini (56% benign / ~2% ASR weighted) to CaMeL on GPT-4o (77% benign / 0% escapes). The comparison is "tier-adjusted at best" because CaMeL has not published GPT-4o-mini numbers and we have not published GPT-4o numbers. A reviewer can reasonably flag the superlative claim ("strongest ASR reducer in the comparator set") as not rigorously supported. Re-running AgentDojo on GPT-4o as the defended agent closes the tier-match question directly.
**Priority:** Medium-high. Not blocking for submission — §4.4 can be published with the option-(b) rewrite — but the GPT-4o numbers produce a strictly stronger defence-comparison table and close a natural reviewer question.

## What we have now

The §3.9 AgentDojo run (2026-04-20 / 2026-04-21, `results/agentdojo-b72-*`) used GPT-4o-mini (`gpt-4o-mini-2024-07-18`) as the defended agent. Results:

| Suite | $N_\text{sec}$ | ASR baseline | ASR under v2 | Utility baseline | Utility under v2 |
|---|---:|---:|---:|---:|---:|
| Workspace | 560 | 17.1% [14, 20] | **0.0% [0, 0.7]** | 85.0% | 70.0% |
| Banking   | 144 | 50.0% [42, 58] | **0.0% [0, 2.6]** | 62.5% | 50.0% |
| Slack     | 105 | 64.8% [55, 73] | 1.9% [0.5, 6.7]  | 81.0% | 47.6% |
| Travel    | 140 | 34.3% [27, 43] | 6.4% [3.4, 12]   | 55.0% | 55.0% |
| **Weighted** | 949 | 29.9% | **~2.0%** | 71% avg | 56% avg |

CaMeL (Debenedetti 2025) reports on GPT-4o: 77% benign, 0% escapes. Our published GPT-4o row in Table 24 is "this paper / GPT-4o-mini / 56% benign / ~2% wt. ASR". The juxtaposition with CaMeL's GPT-4o row creates the tier-match concern.

## What this plan adds

Re-run the exact same AgentDojo matrix with the defended agent switched from `gpt-4o-mini-2024-07-18` to `gpt-4o-2024-08-06`. Everything else identical:

- AgentDojo commit `18b501a` (version `v1.2.2`)
- Attack: `important_instructions` (the 2024 paper's strongest)
- Defence bridge: prompt v2 + Claude Haiku 4.5 judge + Cohere Embed v4, `deny=0.15`, `review=0.60`
- 949 security-task runs + benign-task corpus (~97 tasks, $N=16$–$40$ per suite)
- Output: drop-in replacement for §4.4 Table 24 row, and a candidate replacement for §3.9 Table 5 if we decide to re-anchor the paper on GPT-4o rather than GPT-4o-mini.

The existing bridge code is agent-model-agnostic (it calls OpenAI's API via the AgentDojo `--attacker-agent-kwargs`/`--agent-kwargs` interfaces). No new code should be required; only a model-ID swap in the runner invocation.

## Hypotheses

**H1 — Defence-effectiveness transfers to GPT-4o.** The paper's architectural claim is that the approval judge is agent-model-agnostic because it operates at the PreToolUse gate with a fixed three-part input (original task + action history + proposed action), not the agent's own conversation. Under H1 the defended ASR on GPT-4o should be in the same band as GPT-4o-mini: 0--2\% on Workspace/Banking, 2--10\% on Slack/Travel, ~2\% weighted. Predicted: weighted defended ASR on GPT-4o within $\pm 2$\,pp of the GPT-4o-mini number (~2\%), and within the Wilson 95\% CI for each suite.

**H2 — GPT-4o baseline ASR matches the 2024 AgentDojo paper (47.7\%).** The undefended GPT-4o baseline is the tier reference point CaMeL reports against. Reproducing it validates the test environment. Predicted: GPT-4o baseline weighted ASR within $\pm 3$\,pp of 47.7\%.

**H3 — Benign utility on GPT-4o under prompt v2 lands between 65\% and 75\%.** GPT-4o baseline benign utility is ~84\% per AgentDojo (and reproduced in Table 24). Prompt v2 applied to GPT-4o-mini imposed a weighted ${-}15$\,pp benign drop. If the drop is a function of prompt v2's catalogue rather than of GPT-4o-mini's capability, GPT-4o should see the same $\Delta$benign: 84\% $\to$ ~69\% weighted. If GPT-4o is materially better at disambiguating "share this summary" from "forward this credential", the drop might be smaller (closer to CaMeL's ${-}7$\,pp). Predicted: 65\%--75\% weighted, with Slack still the worst single cell.

**H4 — Defended GPT-4o places above CaMeL on ASR or below on benign.** The four outcomes:
- *Best case:* defended GPT-4o reaches ~0\% ASR with 70\%+ benign — dominates CaMeL on both axes at tier-matched agent.
- *Expected:* ~2\% ASR / ~65--70\% benign — not strictly dominant (CaMeL 0\% escapes) but tier-match lands clean.
- *Neutral:* ~2\% ASR / ~60\% benign — comparable security, materially worse utility, confirms "complementary" framing in §4.4.
- *Adverse:* ~5\%+ ASR / ~60\% benign — security claim weakens under tier-match, requires explicit acknowledgement in §4.4.

Predicted outcome distribution: *expected* or *best-case* (probability ~70\%); *neutral* (~25\%); *adverse* (~5\%). The *adverse* case remains the most informative for the paper even if unflattering.

## Success criteria

1. **Provenance fields populated** on every result JSON: `build.gitSha`, `bridge.gitSha`, `agent.provider=openai`, `agent.model=gpt-4o-2024-08-06`, `judge.model=eu.anthropic.claude-haiku-4-5-20251001-v1:0`, `judge.prompt=v2`, `embedding.model=cohere.embed-v4:0`, `embedding.thresholds={deny:0.15,review:0.60}`, `benchmark.commit=18b501a`, `benchmark.version=v1.2.2`, `attack=important_instructions`, `run.timestamp`.
2. **Baseline reproduces AgentDojo 2024 paper within $\pm 3$\,pp** on weighted ASR (expected 47.7\%, Wilson 95\% CI derivable from the 949-case aggregate). If the baseline differs by more than 3\,pp, the test environment has drifted (OpenAI model-weight update, benchmark commit mismatch, etc.) and downstream defended numbers should be treated as calibration-dependent.
3. **Defended ASR carries Wilson 95\% CI half-width ≤ 3\,pp** per suite for Workspace (target [0, 0.7] replication), Banking (≤ 3 pp half-width on the 144-case), Slack, and Travel.
4. **Benign utility measured at matched $N$** to the GPT-4o-mini run (AgentDojo's benign corpus is small and fixed per suite).
5. **Wall-clock and cost within budget** (Risks table below).

## Decision rules

**If H1–H3 are supported (defended weighted ASR ~2\%, benign 65--75\%):**
- Replace §4.4 Table 24 row: "This paper / GPT-4o-mini / 56\% / ~2\%" $\to$ split into two rows (GPT-4o-mini and GPT-4o), with GPT-4o row tier-matched to CaMeL.
- Rewrite §4.4 summary paragraph: "on GPT-4o (tier-matched to CaMeL) this paper's defence achieves [X]\% weighted ASR at [Y]\% weighted benign utility, versus CaMeL's 0\% escapes at 77\% benign". State the ASR/utility trade-off explicitly.
- Retain the "complementary rather than competing" framing in the closing paragraph.
- §3.9 keeps GPT-4o-mini as the headline (explicit non-Anthropic test) with a footnote or additional table row for the GPT-4o tier-match.

**If H4 *adverse* case (defended GPT-4o ASR > 5\% or benign < 55\%):**
- Paper's "strongest ASR reducer" claim in §4.4 summary does not survive unchanged. Rewrite: "this paper's defence is strongest on GPT-4o-mini; on tier-matched GPT-4o the defence is comparable to or trails CaMeL". The test reveals a model-tier dependency worth reporting honestly.
- §3.4 (prompt v2) conclusions are unaffected (catch rate is measured on Anthropic judges, not GPT-4o).
- Add a new Limitations paragraph on defended-agent-tier dependency.
- Add a new Future Work item on characterising the defence across defended-agent tiers.

**If H2 fails (GPT-4o baseline ASR deviates from 47.7\% by > 3\,pp):**
- Stop. Diagnose environment drift before spending ~\$200 on the defended arm. Common causes: OpenAI silently updating the model behind the `gpt-4o-2024-08-06` alias, AgentDojo benchmark commit divergence, `--attacker-agent-kwargs` default change.
- Re-run with `gpt-4o-2024-11-20` or the newest pinned snapshot, and reference which OpenAI snapshot is used in all paper cites.

## Execution

### Infrastructure

- **Bedrock side:** unchanged (Haiku 4.5 + Cohere v4 in `eu-central-1`, already provisioned).
- **OpenAI side:** account with `gpt-4o-2024-08-06` access. This is the reference GPT-4o snapshot at the time of AgentDojo's 2024 paper; it is still available on the OpenAI API as of 2026-04-24.
- **Bridge code:** `agentdojo_defence_bridge.py` as released. No code changes — only the model-ID flag to the AgentDojo runner.
- **Benchmark:** `agentdojo==1.2.2`, commit `18b501a`. Already pinned in the reproducibility scripts.

### Command

```bash
# Baseline (undefended) arm — reproduces 2024 paper's 47.7% weighted ASR
python -m agentdojo.scripts.benchmark \
  --benchmark-version v1.2.2 \
  --suite workspace banking slack travel \
  --attack important_instructions \
  --model gpt-4o-2024-08-06 \
  --model-provider openai \
  --no-defense \
  --logdir results/agentdojo-gpt4o-baseline-2026-04-24/

# Defended arm — prompt v2 + Haiku 4.5 + Cohere v4
python -m agentdojo.scripts.benchmark \
  --benchmark-version v1.2.2 \
  --suite workspace banking slack travel \
  --attack important_instructions \
  --model gpt-4o-2024-08-06 \
  --model-provider openai \
  --defense-url http://localhost:8080/evaluate \
  --defense-config '{"judge_model":"eu.anthropic.claude-haiku-4-5-20251001-v1:0","judge_prompt":"v2","embedding_model":"cohere.embed-v4:0","deny":0.15,"review":0.60}' \
  --logdir results/agentdojo-gpt4o-b72-2026-04-24/
```

(Actual flags depend on the AgentDojo runner's current CLI surface; the existing GPT-4o-mini runs in `results/agentdojo-b72-*` carry the canonical invocation in their `run-*.log` files.)

### Wall-clock and cost

- **AgentDojo runtime on GPT-4o:** the 2024 paper reports ~3--4 hours per suite on GPT-4o at full benchmark size. Four suites, two arms (baseline + defended) = ~30 hours wall-clock serial, ~8 hours if parallelised across suites.
- **OpenAI cost estimate:** GPT-4o is \$2.50/M input, \$10.00/M output.
  - 949 security tasks + ~97 benign tasks $\approx$ 1{,}046 distinct task runs × 2 arms = 2{,}092 runs.
  - Average per-run ${\sim}8{,}000$ input + ${\sim}1{,}500$ output tokens (estimated from AgentDojo's typical multi-turn task trace; will refine from the GPT-4o-mini logs).
  - Input cost: $2{,}092 \times 8{,}000 / 10^6 \times \$2.50 \approx \$42$.
  - Output cost: $2{,}092 \times 1{,}500 / 10^6 \times \$10.00 \approx \$31$.
  - Baseline arm carries no defence-call overhead; defended arm adds ~20 Haiku 4.5 judge calls per task at ~350 in + 80 out tokens each (negligible Bedrock cost, ${\sim}\$0.50$ across the full run).
  - **Agent inference estimate:** ~\$75--100. Refine against GPT-4o-mini run logs once the actual per-task token distribution is confirmed.
  - Adding ~20\% buffer for retries, longer-than-expected traces, and the defended arm's judge-pass overhead: **budget cap \$150**.
- **Bedrock cost:** embeddings + judge combined ${\sim}\$2$.
- **Total budget cap:** \$175 all-in.

### Paper integration (if H1--H3 support)

**§4.4 Table 24 updates:**

Before:

| Defence | Class | Defended agent | Benign | ASR |
|---|---|---|---:|---:|
| This paper | Tool-call approval | GPT-4o-mini | 56\% avg | ~2\% wt. |

After:

| Defence | Class | Defended agent | Benign | ASR |
|---|---|---|---:|---:|
| This paper | Tool-call approval | GPT-4o-mini | 56\% avg | ~2\% wt. |
| This paper | Tool-call approval | GPT-4o (tier-match) | [Y]\% avg | [X]\% wt. |

**§4.4 summary rewrite:** the superlative claim is replaced with a tier-matched comparison (see Decision rules). The "complementary rather than competing" framing is retained.

**§3.9 Table 5 options:**

- *Retain GPT-4o-mini as headline:* add a second summary row for GPT-4o. Keeps the non-Anthropic-agent test (GPT-4o-mini) as the generalisation claim, with GPT-4o as a tier-match corroborator.
- *Switch headline to GPT-4o:* stronger numbers (higher benign baseline, closer to published CaMeL comparison), but loses the "much cheaper non-Anthropic model" framing.

Recommend the first option; the second is a judgement call the lead author should make.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OpenAI rate limits on concurrent GPT-4o calls | Medium | Medium | Tier 3+ OpenAI account; fall back to serial execution per suite if 429s appear |
| GPT-4o snapshot drift since 2024 paper (baseline ASR differs) | Low–Medium | Medium | H2 decision rule — stop and diagnose if baseline off by >3 pp |
| Cost overrun (benign-task traces longer on GPT-4o than expected) | Medium | Low | Budget cap \$175; halt at \$200 and report partial matrix |
| Defended ASR materially higher on GPT-4o than GPT-4o-mini (H4 adverse) | Low | High | Not a reason to halt — this is the informative outcome; narrate honestly in §4.4 |
| AgentDojo benchmark `v1.2.2` task set changed since earlier runs | Low | Medium | Pin commit `18b501a`; diff against the earlier run's task IDs before interpreting |
| Bridge code incompatibility with OpenAI's GPT-4o response format | Low | Medium | Smoke-test: 3 Workspace tasks on GPT-4o baseline, verify bridge correctly logs judge verdicts, before scaling |

## Non-goals

- **CaMeL re-run.** Independently reproducing CaMeL on GPT-4o-mini would close the tier-match from the other direction but is out of scope (CaMeL's reference implementation is not trivially portable; would require ~2 weeks of engineering).
- **Cross-model approval on GPT-4o.** GPT-4o as the *defended* agent (this plan) is different from GPT-4o as the *judge*. The judge in §3.9 remains Claude Haiku 4.5 + prompt v2.
- **Other AgentDojo attacks.** The `important_instructions` attack is the 2024 paper's strongest; other attacks (`tool_knowledge`, `direct_chat`) are secondary and not needed for M2.
- **Additional suites.** AgentDojo's four suites (workspace, banking, slack, travel) are the full benchmark for the `important_instructions` attack.

## Dependencies on other open items

- **Independent of:** `test-plan-cross-model-recommended-pipeline-2026-04-24.md` (M1). M1 is Claude-agent × T3-scenario; M2 is GPT-4o × AgentDojo.
- **Reuses:** the AgentDojo bridge code, the prompt v2 constant, the Haiku 4.5 judge, and the Cohere v4 embedding pipeline — all released and pinned.
- **Complements (not blocks):** §4.4 option-(b) rewrite from the peer review (a 3-sentence tier-adjustment caveat). If this test lands before the submission deadline, the tier-match numbers replace the caveat; if not, the caveat stands and this test is reviewer-response material.
