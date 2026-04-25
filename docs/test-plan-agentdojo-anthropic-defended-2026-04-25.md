# Test Plan — AgentDojo with Sonnet 4.6 and Opus 4.7 as Defended Agents

**Date:** 2026-04-25
**Context:** P15 §3.7 (External Validation on AgentDojo) covers two defended-agent rows: GPT-4o-mini (29.9% baseline ASR → ~2% defended) and GPT-4o (~39% → ~3--7%). Test 20 will add two more rows for Qwen3.5/Qwen3.6 open-weights agents. **What §3.7 still doesn't cover: the agents the paper actually recommends as deployment targets.** Sonnet 4.6 is the headline-recommended deployment per §4.7 Conclusions; Opus 4.7 is the system-card reference cited in §1.3 and §4.4. Both are tested as the *judge* throughout the paper, and as the *defended agent* on the researcher-authored corpora (T3, T3e, FPR), but neither has been measured as a defended agent on the canonical external benchmark. Test 18 (T3e) showed Sonnet/Opus 4.7 refuse the user-turn-reframing pretexts at the model layer, but AgentDojo's `important_instructions` attack lives in tool outputs --- a different attack surface --- and Anthropic's own Shade adaptive evaluation in the Opus 4.7 system card reports 25--52.5% residual ASR even with their production safeguards. The model layer is **not** at the floor on adversarial pressure; AgentDojo on Sonnet/Opus is plausibly in the measurable range.
**Priority:** Medium-high. Closes the §3.7 cross-vendor matrix on the recommended-deployment tier and pre-empts the natural reviewer question: ``you've measured the defence on every defended-agent class except the ones the paper recommends; why?'' Adds cost (~\$400--500) but produces evidence on the configuration that will actually ship.

## What we have now

| Defended agent | Provider | AgentDojo measured? | Source |
|---|---|---|---|
| GPT-4o-mini | OpenAI commercial | **Yes** (Test 12a/c, Sonnet 4.6 judge) | §3.7 Table 10 |
| GPT-4o | OpenAI commercial | **Yes** (Test 17, Sonnet 4.6 judge) | §3.7.7 |
| Qwen3.5 / Qwen3.6 | Alibaba open-weights | Pending (Test 20) | --- |
| **Sonnet 4.6** | **Anthropic commercial** | **No** | --- |
| **Opus 4.7** | **Anthropic commercial** | **No** | --- |
| Sonnet 4.6 / Opus 4.7 (T3e) | Anthropic, researcher corpus | Yes (Test 18) | §3.6 |
| Sonnet 4.6 / Opus 4.7 (T3 Stop-hook) | Anthropic, researcher corpus | Yes (Test 16) | §3.5 |

A reviewer can reasonably ask: ``you tested the defence on GPT-4o-mini, GPT-4o, and Qwen variants --- but not on the agents you actually recommend deploying on. Why?'' The honest answer right now would be: ``Test 18 shows Sonnet/Opus refuse T3e at baseline, so we expected baseline-floor behaviour on AgentDojo too.'' But that doesn't address whether AgentDojo's tool-output-injection attack class (a different attack surface from T3e's user-turn-reframing) lands at the floor or in the measurable range. Anthropic's own Shade adaptive numbers say it's in the measurable range.

## What this plan adds

Two new defended-agent rows in §3.7 Table~10: **Claude Sonnet 4.6** and **Claude Opus 4.7**, both via Bedrock, evaluated against AgentDojo's `important_instructions` attack across all four suites (Workspace, Banking, Slack, Travel) under both no-defence and prompt-v2 arms. Reuses the Test 12/17 fargate entrypoint pattern unchanged --- only the agent-side `--model` flag changes. After this test, §3.7 Table 10 spans six defended-agent rows: GPT-4o-mini, GPT-4o, Qwen3.5, Qwen3.6, **Sonnet 4.6**, **Opus 4.7**.

| Axis | Values | Notes |
|---|---|---|
| Defended agent | Claude Sonnet 4.6 (`eu.anthropic.claude-sonnet-4-6`) **and** Claude Opus 4.7 (`eu.anthropic.claude-opus-4-7`) via Bedrock | Same Bedrock inference profiles as Tests 16/18. |
| Attack | `important_instructions` | Same attack class as Tests 12/17/20 (the AgentDojo 2024 paper's strongest). |
| Suites | workspace, banking, slack, travel | Full AgentDojo `v1.2.2` corpus; matches Tests 12/17. |
| Defence | none, intent-tracker (= dredd PreToolUse + prompt v2 + Cohere v4 + Sonnet 4.6 judge) | Two arms per model. |
| Repetitions | 1 per task (per AgentDojo convention) | 949 security tasks + ~97 benign tasks, ${\times}\,2$ arms ${\times}\,2$ models = ${\sim}4{,}184$ task runs. |
| Benchmark commit | `18b501a` | Same commit pinned in Tests 12/17/20. |
| Judge model | `eu.anthropic.claude-sonnet-4-6` via Bedrock | Same as Tests 12/17/20. |
| Embedding | `eu.cohere.embed-v4:0` via Bedrock | Same as Tests 12/17/20. |
| Thresholds | `deny=0.15`, `review=0.60` | Same as Tests 12/17/20. |
| Reasoning effort | default (`none`) on both agent and judge | Matches §4.7 ``Sonnet 4.6 + prompt v2 at \texttt{none} effort'' production recommendation. |

**Total task runs:** ~4{,}184. Reduced-subset fallback (Workspace + Banking only): ~3{,}080. Sonnet-only fallback: ~2{,}092.

**Pilot priority order:**
1. Sonnet 4.6 baseline + defended on all four suites (the headline-recommendation row; $$\sim$\$110$ at full corpus).
2. Opus 4.7 baseline + defended on all four suites (the Opus 4.7 system-card reference; $$\sim$\$340$ at full corpus).

If hardware time and budget are tight, ship Sonnet 4.6 only and add an explicit Future Work item for Opus 4.7. Sonnet 4.6 alone closes the principal "we don't measure the recommended deployment" gap.

## Hypotheses

**H1 --- Sonnet 4.6 baseline ASR is in 5--25\% weighted.** Anthropic's prompt-injection training is strong but not at the floor on AgentDojo's tool-output injection structure. Per the Opus 4.7 system card, Sonnet 4.6 reaches 80\% adaptive ASR with thinking and 100\% without on the Shade adaptive coding-attack benchmark *with* their production safeguards applied. AgentDojo's `important_instructions` is a static (non-adaptive) attack at smaller per-task budget, so we expect a much lower ASR than Shade's adaptive numbers --- but not zero. Predicted: 5--25\% weighted baseline ASR.

**H2 --- Opus 4.7 baseline ASR is lower than Sonnet 4.6 (3--15\% weighted).** Opus 4.7 is reported in the system card as Anthropic's strongest agent on injection resistance, and the system-card Shade ASR numbers (with safeguards) are 25--52.5\% --- materially lower than Sonnet 4.6's. Predicted: 3--15\% weighted baseline ASR.

**H3 --- Defended ASR drops to single digits weighted under prompt v2 on both Anthropic agents.** The defence is judge-side and mechanism-independent of the defended agent's training. The 28--36\,pp ASR reduction observed on GPT-4o-mini and GPT-4o should carry over to Sonnet 4.6 and Opus 4.7 in absolute terms even though the absolute baseline is lower. Predicted: 1--8\% defended weighted ASR on both Anthropic agents.

**H4 --- Benign utility drops 10--25\,pp under prompt v2** for the same domain-overlap reason as the OpenAI runs (prompt v2's red-flag catalogue overlaps with messaging/banking legitimate-action shapes). Slack will be the worst suite; Travel approximately flat. Holds for both Anthropic agents.

**H5 --- The Anthropic-as-defended-agent rows show within-vendor consistency.** Sonnet 4.6 and Opus 4.7, both trained on similar adversarial-injection corpora, should land in adjacent positions on the trade-off curve: similar baseline ASR profiles, similar defended ASR, similar utility drops. If H5 fails (the two rows differ by >10\,pp on any axis): suggests within-vendor model-tier matters more than the cross-vendor framing predicts.

**H6 --- Bedrock-served Claude agents come with Anthropic's representation probes already active.** Per the Opus 4.7 system card, Anthropic's probes are *enabled by default in many of our agentic products*. Whether Bedrock-served Claude inherits those probes is not publicly documented; the result is that this paper's "no defence" arm is functionally **"agent + Anthropic's training + Anthropic's bedrock-tier safeguards"**, not a true "stripped agent". This is the realistic deployment scenario but should be explicit in the writeup. The defence's marginal effect is therefore *over and above* whatever Anthropic ships at the API tier --- a meaningful position rather than a methodological problem.

## Success criteria

1. **Provenance fields populated** on every result JSON: `agent.provider=bedrock`, `agent.model` (one of `eu.anthropic.claude-sonnet-4-6`, `eu.anthropic.claude-opus-4-7`), `judge.model=eu.anthropic.claude-sonnet-4-6`, `judge.prompt=v2`, `embedding.model`, `embedding.thresholds`, `benchmark.commit=18b501a`, `benchmark.version=v1.2.2`, `attack=important_instructions`, `run.timestamp`, `bedrock.region`.
2. **Baseline ASR Wilson 95\% CI half-width ≤ 5\,pp per suite** at AgentDojo's per-suite $N_\text{sec}$ (Workspace 560, Banking 144, Slack 105, Travel 140). At full corpus this gives weighted-aggregate CIs ≤ 2\,pp.
3. **Defended ASR achieves Wilson 95\% upper bound ≤ 12\%** weighted across suites, conditional on H3.
4. **No mid-run Bedrock rate-limit or service-tier crashes.** If Sonnet 4.6 or Opus 4.7 hit rate limits at AgentDojo's request rate, drop to single-suite-at-a-time serial throughput and increase per-call retry budget.
5. **Defence bridge (`benchmarks/agentdojo/dredd_defense.py`) unchanged from Tests 12/17/20.** The only source change is in the test harness `benchmarks/agentdojo/run_benchmark.py`, where two `--model` mappings are added (`sonnet-4-6` → `eu.anthropic.claude-sonnet-4-6`, `opus-4-7` → `eu.anthropic.claude-opus-4-7`). The interception logic, judge prompt, embedding, and threshold configuration are byte-identical to Tests 12/17/20.

## Decision rules

**If H1 + H2 + H3 hold (Sonnet baseline 5--25\%, Opus baseline 3--15\%, defended <8\% on both):**
- Add two rows to §3.7 Table~10. Headline: *"the defence reduces weighted ASR from $X$\% to $Y$\% on Sonnet 4.6 and from $X'$\% to $Y'$\% on Opus 4.7, demonstrating that the recommended deployment configuration produces measurable security gains on the canonical external benchmark."*
- Update §4.5 Limitations *"Defence effect is bounded by the defended agent's baseline refusal reflex"* — the AgentDojo result on Sonnet/Opus shows the defence does have a measurable effect on the recommended-deployment agents on at least one attack class (AgentDojo's tool-output injection), even though it does not on the T3e user-turn-reframing class. Two attack-class data points characterise the defence's surface area on Anthropic agents directly.
- Reframe §4.7 Conclusions: the defence claim now rests on AgentDojo measurements across *six* defended-agent rows including the two recommended-deployment rows. Substantially stronger than the current four-row footing.

**If H1 fails low (Sonnet baseline <3\%) or H2 fails low (Opus baseline <2\%):**
- Sonnet/Opus refuse AgentDojo's `important_instructions` at the model layer too. Both major researcher-authored attack classes (T3e + AgentDojo `important_instructions`) hit the floor on Anthropic agents.
- This is a strong baseline-resistance finding for current Anthropic agents in its own right, even though it doesn't demonstrate the defence's marginal effect on these specific cells.
- Paper consequence: §4.5 Limitations gains a second data point for the "Anthropic refuses at floor" position. Combined with T3e (§3.6) it becomes: *"on two distinct attack classes (T3e user-turn reframing and AgentDojo tool-output injection) current Sonnet 4.6 / Opus 4.7 refuse at <5\% baseline ASR, leaving the defence with limited marginal surface area on these (model, attack-class) combinations. The defence's effect is most directly measurable on agents whose injection-resistance training is weaker (GPT-4o-mini, GPT-4o, open-weights Qwen)."*
- §3.7 still gets the new rows but the framing changes to a baseline-resistance contribution rather than a defence-effect demonstration.

**If H3 fails (defended ASR materially equal to baseline, the defence has no observable effect):**
- The judge is being bypassed somehow on Sonnet/Opus that it isn't on GPT-4o-mini/GPT-4o or Qwen. Possible causes: (i) Anthropic models structure their tool-call descriptions differently in a way that maps to high embedding similarity (auto-allow), (ii) the judge's prompt-v2 catalogue has a blind spot the GPT-4o family doesn't trigger but Anthropic models do, (iii) Bedrock-served Claude already filters the attack at the API tier so the judge never sees a hijacked-class proposal.
- Diagnostic: log all judge verdicts and trace which calls were routed to which Stage. If Sonnet/Opus Stage-2 auto-allow rates are materially higher than GPT-4o's, that's (i). If Sonnet/Opus reach the judge but get `consistent` more often, that's (ii). If the agent never proposes the hijacked tool call, that's (iii).
- This is the most informative possible negative outcome and would shift the paper substantially. Likelihood low (<10\%).

## Execution

### Infrastructure

- **Bedrock side:** unchanged from Tests 12/17/18. `eu-west-1` for the agents and judge; Cohere v4 embedding in `eu-central-1` (or wherever the Cohere v4 inference profile lives). Both Sonnet 4.6 and Opus 4.7 access already provisioned per Test 18.
- **AgentDojo:** version `v1.2.2` (commit `18b501a`), same as Tests 12/17/20. Pre-installed in the Fargate image used for Tests 12/17.
- **Defence bridge + judge server:** unchanged from Test 17. Reuses `fargate/docker-entrypoint-test12{a,b,c}.sh` pattern with the agent flag adapted to Anthropic IDs and the agent backend switched from `--backend openai` to `--backend bedrock`.

### Command

```bash
# ── Terminal 1: Dredd judge server (Bedrock backend, Sonnet 4.6 judge, prompt B7.1)
AWS_REGION=eu-west-1 npx tsx src/server.ts \
  --backend bedrock \
  --judge-model eu.anthropic.claude-sonnet-4-6 \
  --embedding-model eu.cohere.embed-v4:0 \
  --prompt B7.1 \
  --port 3001

# ── Terminal 2: AgentDojo runs against both Anthropic agents
# The benchmarks/agentdojo/run_benchmark.py runner already supports
# --backend bedrock with Claude model IDs; the entrypoint pattern below
# mirrors test17 (which used --backend openai for GPT-4o).

for AGENT in eu.anthropic.claude-sonnet-4-6 eu.anthropic.claude-opus-4-7; do
  AGENT_TAG="${AGENT##*claude-}"   # sonnet-4-6 / opus-4-7

  # --- Baseline (no defence) ---
  AWS_REGION=eu-west-1 \
  python3 benchmarks/agentdojo/run_benchmark.py \
    --backend bedrock --model "$AGENT" \
    --aws-region eu-west-1 \
    --attack important_instructions \
    --all-suites \
    --logdir "results/test21/${AGENT_TAG}-baseline/" \
    -f

  # --- Defended (prompt v2 = B7.1) ---
  AWS_REGION=eu-west-1 \
  python3 benchmarks/agentdojo/run_benchmark.py \
    --backend bedrock --model "$AGENT" \
    --aws-region eu-west-1 \
    --attack important_instructions \
    --all-suites \
    --defense B7.1 \
    --dredd-url http://localhost:3001 \
    --logdir "results/test21/${AGENT_TAG}-defended-b71/" \
    -f
done
```

A new `fargate/docker-entrypoint-test21.sh` mirroring `test12c.sh` but with `--backend bedrock` and Anthropic model IDs is the cleanest deployment path; ~50 lines of shell, mostly copy-paste from test12c.

### Wall-clock and cost

**Bedrock costs (single arm = full AgentDojo corpus, ~1{,}046 tasks):**

Per AgentDojo task (multi-turn, ~5--12 turns within the harness):
- Input tokens: ~3{,}000--8{,}000 across the conversation
- Output tokens: ~500--1{,}500
- Mid-range estimate: 5{,}000 in, 1{,}000 out per task

| Component | Rate | Per-task | Per-arm (1,046 tasks) |
|---|---|---|---|
| Sonnet 4.6 agent | \$3 / \$15 per M | \$0.030 | **~\$31** |
| Opus 4.7 agent | \$15 / \$75 per M | \$0.150 | **~\$157** |
| Sonnet 4.6 judge (defended only, ~10 calls/task) | \$3 / \$15 per M | \$0.023 | **~\$24** |
| Cohere v4 embedding | \$0.12/M in | \$0.0001 | **~\$0.10** |

**Sonnet 4.6 total (baseline + defended):** \$31 (baseline agent) + \$31 (defended agent) + \$24 (judge) ≈ **~\$90**.

**Opus 4.7 total (baseline + defended):** \$157 (baseline agent) + \$157 (defended agent) + \$24 (judge) ≈ **~\$340**.

**Both models total: ~\$430.**

(The Opus 4.7 agent cost dominates because Opus 4.7 is 5× more expensive than Sonnet 4.6 per token. If Opus 4.7 is dropped from this test plan, total falls to ~\$90.)

**Wall-clock estimate:**

Bedrock throughput: ~30--80 tok/s aggregate per agent at AgentDojo's request rate. Per-task wall-clock ~25--45\,s. Full corpus per model (baseline + defended): ~15--25\,h.

- Sonnet 4.6: ~15--25\,h
- Opus 4.7: ~20--30\,h (Opus's adaptive thinking adds variable per-call latency)

**Both models in series: ~35--55\,h.** Can run baseline and defended arms in parallel for each model (different Bedrock quota lanes), cutting wall-clock to ~20--30\,h total.

**Budget cap:** \$500 all-in (~15\% headroom on the high estimate). Halt if exceeded; report partial matrix.

### Pilot before full run

Smoke-test on Workspace only with **Sonnet 4.6 first** (cheapest, fastest, the headline-recommended deployment). Baseline + defended arms = ~1{,}120 task runs; ~3--5\,h wall-clock; ~\$15 cost. Validates that Bedrock-served Claude integrates with AgentDojo + dredd-bridge cleanly before committing to the full ~\$430 run.

If the Sonnet 4.6 Workspace pilot shows H1 (baseline 5--25\%) and H3 (defended <8\%) holding, proceed to:
1. Full Sonnet 4.6 corpus (Banking + Slack + Travel).
2. Opus 4.7 Workspace pilot (validates Bedrock-served Opus 4.7 routing).
3. Full Opus 4.7 corpus.

### Paper integration (if H1 + H2 + H3 support)

**§3.7 Table~10 update:** add **two new rows** for Claude Sonnet 4.6 and Claude Opus 4.7. After Test 20 + Test 21 the table spans **six defended-agent rows** across three vendors:

- OpenAI commercial (mini, large)
- Open-weights mid-size (Qwen3.5, Qwen3.6)
- Anthropic commercial (Sonnet 4.6, Opus 4.7)

**§3.7.7 Tier-Match update:** the section currently compares GPT-4o-mini (paper) to GPT-4o (CaMeL). Add a third paragraph noting the Anthropic rows: this paper is now the only published cross-vendor evaluation that measures the same defence on the recommended deployment target, against an external benchmark.

**§4.5 Limitations pre-emption updates:** the second pre-emption point (``non-Anthropic agents tested on the same attack class are not at the floor'') gains evidence on the *Anthropic* axis too --- showing whether Anthropic agents are at the floor on AgentDojo (different attack class from T3e). Two outcomes:
- If Anthropic baseline ASR is non-zero on AgentDojo: the defence has measurable surface area on Anthropic too; the ``defence is most useful where baseline is weakest'' claim is *contextualised* rather than absolute.
- If Anthropic baseline ASR is at the floor: the §4.5 baseline-refusal limitation gets a second piece of evidence; the position becomes *"Anthropic refuses both researcher-authored T3e and external-benchmark AgentDojo at the floor; the defence's measurable effect is on weaker-baseline agents"*. Either way an honest, grounded position.

**§4.6 Future Work updates:** the cross-vendor evaluation item is now substantially complete (six rows across three vendors); demote to *"extends further to Llama, Mistral, Gemini, and additional Anthropic releases as they ship"*.

**§4.4 Defence comparison table:** the tier-match comparison to CaMeL becomes more precise. Currently we have GPT-4o-mini (ours) vs GPT-4o (CaMeL) which is tier-mismatched. After Test 21 we have Sonnet 4.6 (ours) vs GPT-4o (CaMeL) which is closer to tier-matched (similar parameter scale and capability tier), plus the original GPT-4o-mini tier-mismatch row.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bedrock rate limits at full AgentDojo throughput on Sonnet/Opus | Medium | Medium | Same as Test 17; in-runner backoff. Spread across `eu-west-1` and `eu-central-1` profiles if available |
| Opus 4.7 cost overrun (longer-than-expected traces) | Medium | Medium | Budget cap \$500; halt at \$600. Can ship Sonnet-only and report Opus 4.7 as Future Work |
| Anthropic API-tier safeguards interfere with attack delivery (H6 holds strongly) | Low--Medium | Low | Frame the result as "the defence's marginal effect over Anthropic's API-tier defences" rather than as a true "stripped agent + dredd" measurement. Honest, paper-relevant. |
| Sonnet/Opus baseline ASR is at floor (<3\%) | Medium | Low | Decision-rule branch above; baseline-resistance finding is its own publishable result |
| AgentDojo's `--backend bedrock` path has a bug we hit | Low | Medium | Pilot smoke-test catches this. The runner already supports `bedrock` per `run_benchmark.py`; verify the smoke test produces non-degenerate logs |
| Adaptive-thinking quirk on Opus 4.7 (per §4.5 Limitations: Opus 4.7 silently skips reasoning at default effort) | Medium | Low | Already documented in the paper as Opus 4.7's adaptive-thinking caveat. AgentDojo at default effort matches Test 18's measurement convention; no special handling needed beyond noting the result is at default-effort behaviour |

## Non-goals

- **Haiku 4.5 as defended agent.** Haiku 4.5 is recommended in the paper as a cost-efficient *judge*, not as a primary defended agent. Test 12 may have run Haiku-as-agent in some configurations, but adding it as a §3.7 row dilutes the headline Sonnet 4.6 / Opus 4.7 contribution.
- **Opus 4.6 as defended agent.** Opus 4.6 is referenced in the paper for cross-model comparisons (§3.5) but Sonnet 4.6 / Opus 4.7 are the headline-recommended and system-card-cited models respectively.
- **CaMeL on Sonnet/Opus.** CaMeL's reference implementation is bound to specific Anthropic-API-via-tool-calling patterns and would require engineering to port. Out of scope. Test 21 closes the Anthropic gap on this paper's defence; CaMeL remains a tier-aware comparator from published numbers only.
- **AgentHarm.** Different benchmark, different attack catalogue. AgentHarm is cited in §1.3 for context but isn't the canonical external validation this paper anchors on. Adding AgentHarm coverage is a separate Future Work item.
- **Reasoning-effort sweep on Sonnet/Opus as defended agents.** AgentDojo at default effort matches the §4.7 production recommendation. A full effort sweep (`none`/`medium`/`high`/`max`) would be 4× the runs and 5--10× the cost; not paper-relevant for the cross-vendor row claim.
- **Prompt-variant comparison (B7 vs B7.1).** This plan uses prompt v2 (B7.1) only, matching the published headline configuration. Prompt-variant ablation belongs in §3.4 (judge-side adversarial robustness), not §3.7 (defended-agent cross-vendor).

## Dependencies

- **Reuses Tests 12/17/20 infrastructure** (AgentDojo + dredd defence-bridge + Bedrock judge/embedding) unchanged. The cross-vendor surface is purely the defended-agent backend (`--backend bedrock`).
- **Independent of Test 18** (T3e on Sonnet/Opus). Test 18 measures T3e's user-turn-reframing class against Anthropic; Test 21 measures AgentDojo's tool-output-injection class against Anthropic. Two attack-class data points on the same agent tier.
- **Independent of Test 19 + Test 20.** These three Phase-2 tests can run concurrently (different agent backends, separate Bedrock and Ollama quotas).
- **Complements §4.4 defence-comparison table.** After Test 21 the Sonnet 4.6 row in Table 24 is closer to a tier-match against CaMeL's GPT-4o numbers than the current GPT-4o-mini row.

## Stretch follow-ups

If H1+H2+H3 land cleanly:

1. **Add Sonnet 4.5 / older Sonnet variants** to the §3.7 table for Anthropic-internal-trajectory measurement (analogous to the Qwen3.5/Qwen3.6 trajectory in Test 20).
2. **Run Sonnet 4.6 + Opus 4.7 with `--effort max`** to characterise whether explicit reasoning helps on this attack class.
3. **Run the same matrix with Haiku 4.5 as the judge** (cost-efficient alternative, ~25% of the Sonnet 4.6 judge cost) to confirm the cross-row §3.7 result holds when the judge tier is varied.

These are stretch goals, not part of Test 21 proper.
