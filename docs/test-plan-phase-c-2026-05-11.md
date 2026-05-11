# Test Plan — Phase C (Stage B Follow-up Cells)

**Date:** 2026-05-11
**Predecessor:** `docs/phase-b-results-2026-05-11.md`
**Predecessor plan:** `docs/test-plan-promptarmor-headtohead-2026-05-08.md`
**Cloud-Security commit referenced:** Phase B numbers landed in p15b at commit on 2026-05-11; this plan defines the cells needed to upgrade contribution 3 in p15b §1.3 from "in-framework head-to-head on two of five corpora" to a fuller "head-to-head on five corpora".

Phase B (2026-05-10/11) covered AgentDojo workspace × `important_instructions` and InjecAgent base across `none` / `B7.1` / `promptarmor` defences. Headline finding was Qwen3-32B on InjecAgent: baseline ASR 24.5% → Dredd v2 0.1% vs PromptArmor 1.2%. Phase C extends this to close the four cell gaps the paper's contribution-3 claim still depends on.

**Authorised budget:** TBD (this is the request). Phase B used the original $250 cap and largely came in under; the cells listed below should be costable from the same Bedrock + Fargate task family at ~$30–80 per cell, so the entire Phase C is in the $150–300 range.

**Wall-clock:** 2–4 days, mostly Fargate task time. The Opus-4-7 InjecAgent rerun is ~1 hour wall-clock once kicked off; the corpora additions are 1–3 hours wall-clock each per (agent, defence) cell.

---

## C0. Operational fixes (no new spend, must land first)

### C0.1. PromptArmor `/screen` timeout

Phase B AgentDojo PromptArmor cells fired `/screen` against the `judge-ai-dredd-interactive` hook container with a 30s per-call timeout. Under concurrent bedt3+bedt4 load, Bedrock latency for the Sonnet-based detector exceeded 30s for many calls and PromptArmor fail-opened. ASR stayed 0% because the Claude agents weren't being hijacked anyway, but the cells reflect partial coverage rather than full screening.

**Fix:** bump `benchmarks/agentdojo/promptarmor_defense.py` timeout to 90s, or split PromptArmor onto its own hook slot. Required before any Phase C PromptArmor cell runs on a non-saturated agent (Qwen3-32B, GPT-4o-mini) where fail-open would invalidate the ASR comparison.

### C0.2. Opus-4-7 Bedrock `temperature` deprecation

Already fixed in `bedrock-client.ts` and `benchmarks/injecagent/run_benchmark.py` at commit `1b4341f5`. Confirms the Phase C Opus rerun (C1) is unblocked.

### C0.3. Container build hygiene

Phase B used two zip artefacts (`judge-ai-dredd-promptarmor-bedrock` for AgentDojo, `judge-ai-dredd-injecagent` for InjecAgent). Both incorporate post-Phase-B fixes since they were built. Confirm a clean rebuild from current `main` before kicking off any C-cell. Run IDs should be `phaseC-` prefixed.

---

## C1. Re-run Opus-4-7 InjecAgent (Phase B blocker)

**Why:** Phase B Opus-4-7 InjecAgent cells aborted with `temperature is deprecated` validation error from Bedrock Converse. The fix landed at commit `1b4341f5`; the cells need to be re-run against the corrected image.

**Scope:** `none` + `B7.1` + `promptarmor` on Opus-4-7 against InjecAgent base (544 valid Total / 510 valid Direct-Harm).

**Expected results:** Anthropic safety training is likely to drive Opus-4-7 ASR to 0% as it did Sonnet 4.6 (saturation). The rerun's value is documenting the saturation explicitly and completing the table row group; the absence is more noticeable than its presence.

**Estimated cost / time:** ~$20–40, ~1 hour wall-clock per defence (3 hours total). One Fargate task on bedt4.

**Decision rule:** if Opus-4-7 baseline ASR > 5%, this is a notable cross-vendor finding (Opus less injection-resistant than Sonnet on InjecAgent); flag and double-check the data before reporting. Otherwise the row is a saturation row and the paper text just gets updated.

---

## C2. AgentDojo non-workspace suites (banking, slack, travel)

**Why:** Phase B covered only the `workspace` suite of AgentDojo, against the `important_instructions` attack. AgentDojo defines four suites (workspace, banking, slack, travel) with different tool surfaces. Reviewers may ask why we generalise from one suite.

**Scope:** `none` + `B7.1` + `promptarmor` on Sonnet 4.6 + Opus 4.7 (and ideally GPT-4o-mini per C5) against each of `banking`, `slack`, `travel` × `important_instructions` attack.

**Expected results:** Likely saturated on Anthropic agents like workspace was. Banking and travel are interesting because they have more tools-per-task and more network egress; potentially the cells where PromptArmor's content screening would matter more if the saturation breaks.

**Estimated cost / time:** ~$100–180 total (each suite is ~$30–60 per agent), ~10–14 hours wall-clock with PromptArmor cells dominating. Suggest dropping at least one of (banking, slack, travel) if the budget binds; banking and workspace are the most paper-relevant.

**Decision rule:** if all three non-workspace suites also saturate on Anthropic agents (likely), document the saturation pattern as a paper finding ("Anthropic safety training neutralises the `important_instructions` attack class across the full AgentDojo taxonomy") and skip running PromptArmor cells on the saturated suites in any subsequent rerun.

---

## C3. MT-AgentRisk head-to-head

**Why:** MT-AgentRisk is one of the five corpora in p15b §4 preamble; Phase B did not cover it. The paper's existing MT-AgentRisk data in `tab:cross-corpus-summary` predates Phase B and does not include PromptArmor. Closes one of the three pending head-to-head cells.

**Scope:** `none` + `B7.1` + `promptarmor` on the production-recommended judge configuration (Sonnet 4.6 + prompt v2) across MT-AgentRisk's existing cross-vendor matrix (Sonnet, Opus, GPT-4o-mini, Bedrock-Qwen3 235B A22B).

**Expected results:** Anthropic cells likely saturated; the differentiating cells are GPT-4o-mini and Qwen3-235B where p15's existing data shows non-trivial baseline ASR. Expected pattern mirrors the InjecAgent finding: action-side judge with low residual; PromptArmor with higher residual on cells where content classification on long-horizon tool-grounded harmful goals is the weaker signal.

**Estimated cost / time:** ~$40–80, ~2–4 hours wall-clock per agent × 4 agents (Sonnet, Opus, GPT-4o-mini, Qwen3-235B).

**Decision rule:** if PromptArmor on MT-AgentRisk fails substantially worse than Phase B InjecAgent (e.g., > 5% ASR on multiple agents), update §6 to emphasise the cross-corpus vulnerability of content-side preprocessing on multi-turn corpora.

---

## C4. AgentLAB head-to-head

**Why:** Fifth corpus; same gap as MT-AgentRisk.

**Scope:** `none` + `B7.1` + `promptarmor` on the AgentLAB smoke-scale matrix used in p15 (N=10 stratified scenarios per cell, 2 per attack type, across seven Bedrock-hosted defended agents).

**Expected results:** AgentLAB's memory-poisoning attack type is a known boundary case for the action-side judge (7.1% defended residual on the existing p15 measurement). PromptArmor's behaviour on memory poisoning is unknown; content-side preprocessing should not directly affect the write-then-read trajectory pattern, so PromptArmor residual could be similar or worse.

**Estimated cost / time:** ~$30–60, ~1–2 hours wall-clock per agent × 7 agents. Smoke-scale so per-cell N is small; do not expect Wilson CIs to be tight.

**Decision rule:** memory poisoning specifically is the cell to watch; if both defences leave non-trivial residual there, the §4.4 scope-boundaries paragraph in p15b stands as written. If PromptArmor catches memory poisoning where the action-side judge does not, that's evidence for the hybrid deployment argument and should be reported in §6.

---

## C5. T3e head-to-head

**Why:** The paper's own T3e corpus; Phase B did not include it because the original Stage B plan deprioritised it (T3e exists in p15 prior-work numbers but without a PromptArmor head-to-head). Reviewers may ask why our own corpus is missing from the head-to-head.

**Scope:** `none` + `B7.1` + `promptarmor` on T3e.2–T3e.4 (the exfiltration-instrumented variants) across Anthropic Sonnet 4.6 and Opus 4.7 + Bedrock-Qwen3-32B + Bedrock-Qwen3-235B-A22B. PromptArmor needs to be wired into the T3e canary-server-instrumented runner.

**Expected results:** Anthropic cells almost certainly saturated (consistent with p15's T3e data showing 0/200 baseline exfil on Sonnet/Opus). Qwen3 cells are where the discrimination signal lives; the Phase B Qwen3-32B InjecAgent finding suggests T3e Qwen3 will follow the same pattern (action-side judge dominates content-side preprocessor).

**Estimated cost / time:** ~$30–50, ~1–3 hours wall-clock per agent × 4 agents.

**Decision rule:** if T3e Qwen3 shows the same Dredd v2 << PromptArmor pattern, this corroborates the Phase B InjecAgent finding on the paper's own corpus and strengthens the contribution-3 claim materially. If the pattern reverses, that's an important methodological finding to surface.

---

## Bonus: cells not in the original five but suggested by Phase B

### C6. GPT-4o-mini on InjecAgent

**Why:** The Phase B Qwen3-32B InjecAgent result was the headline because Qwen3-32B is the only non-Anthropic agent with a baseline signal. GPT-4o-mini is the other non-Anthropic agent in the paper's matrix (already on AgentDojo `important_instructions` for the §4.3 cross-corpus AgentDojo extension). Adding GPT-4o-mini on InjecAgent would test whether the Qwen3-32B finding generalises across non-Anthropic vendor families or is Qwen-specific.

**Scope:** `none` + `B7.1` + `promptarmor` on GPT-4o-mini against InjecAgent base.

**Expected results:** GPT-4o-mini's baseline injection-resistance on InjecAgent is uncharacterised in the paper. Three outcomes possible: (1) saturated at 0% (would extend the Anthropic-floor finding to OpenAI mini-tier), (2) intermediate baseline (10–30%, mirrors the Qwen3-32B regime), (3) high baseline (50%+, suggests OpenAI mini-tier is materially weaker than Qwen3-32B). Either of (2) or (3) gives the paper a second separation cell.

**Estimated cost / time:** ~$15–30, ~1 hour wall-clock. Cheap.

**Recommendation:** include in Phase C even though not in the original five corpora; it directly addresses whether the Qwen3-32B finding generalises.

---

## Aggregated estimate

| Cell | Cost | Time | Priority |
|---|---|---|---|
| C0 (operational fixes) | $0 | 1 hour | Must land first |
| C1 (Opus-4-7 InjecAgent rerun) | $20–40 | 3 hours | High (Phase B blocker) |
| C2 (AgentDojo banking/slack/travel) | $100–180 | 10–14 hours | Medium (drop one if cap binds) |
| C3 (MT-AgentRisk head-to-head) | $40–80 | 8 hours | Medium |
| C4 (AgentLAB head-to-head) | $30–60 | 6 hours | Medium (smoke-scale so small N) |
| C5 (T3e head-to-head) | $30–50 | 8 hours | Medium (corroborates Phase B) |
| C6 (GPT-4o-mini InjecAgent) | $15–30 | 1 hour | Bonus (high information per dollar) |
| **Total** | **$235–440** | **~37 hours** | |

Two natural Phase C sizings:
- **Minimum** (just close Phase B + paper-most-relevant): C0 + C1 + C5 + C6 = $65–120, ~13 hours.
- **Full** (close all five corpora): C0 + C1 + C2 + C3 + C4 + C5 + C6 = $235–440, ~37 hours.

---

## What this enables for the paper

Each cell that lands upgrades a specific p15b claim from "pending" to "measured":

| Phase C cell | p15b claim it upgrades |
|---|---|
| C1 Opus-4-7 InjecAgent | Table 3 InjecAgent / Opus-4-7 row is no longer marked "aborted"; closes the Phase B blocker noted in §4.3 setup paragraph |
| C2 AgentDojo other suites | §6 cost finding generalises beyond `workspace`; closes "AgentDojo other suites not run" gap in `phase-b-results-2026-05-11.md` |
| C3 MT-AgentRisk | Contribution 3 in §1.3 can claim "three-corpus head-to-head" |
| C4 AgentLAB | Contribution 3 can claim "four-corpus head-to-head"; §4.4 memory-poisoning boundary gains a PromptArmor comparison |
| C5 T3e | Contribution 3 can claim "five-corpus head-to-head" (the original Stage B target); paper's own corpus represented |
| C6 GPT-4o-mini InjecAgent | Tests Qwen3-32B finding's generalisation across non-Anthropic vendors |

After C0 + C1 + C5 + C6 (the minimum), contribution 3 can claim "head-to-head on AgentDojo, InjecAgent, and T3e (three of five corpora), with GPT-4o-mini and Qwen3-32B as the cross-vendor cells that produce a baseline signal". After full Phase C, contribution 3 claims a five-corpus head-to-head with the planning-isolation-family comparison via InjecAgent.

---

## Decision points for authorisation

1. **Budget cap for Phase C?** Recommend $300 to cover the minimum + a contingency margin; $500 if going full scope.
2. **Drop order if cap binds?** Recommend AgentLAB (smoke-scale, small N, weakest contribution) first, then AgentDojo non-workspace suites (likely all saturated on Anthropic) second.
3. **PromptArmor backend choice for Phase C?** Phase B used Sonnet 4.6 for parity. Alternative: also test Haiku 4.5 backend (cheaper) to characterise PromptArmor's cost / accuracy trade-off on the same cells.
4. **C6 (GPT-4o-mini InjecAgent) authorised?** It's cheap and high-information; recommended yes.
