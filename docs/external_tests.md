# External Tests and Defences — Candidate Additions for P15

**Date:** 2026-04-26
**Source:** Paper Lantern `explore_approaches` (113 papers surveyed)
**Status:** Discovery; verify each citation via Parallel Web extract before adding to `p15.bib`.
**Scope:** Strengthen P15's cross-vendor / cross-attack-class evidence base for the Springer Cybersecurity submission, and close the §2 Related Work gap on 2025--2026 competing defences.

## Context

P15 currently rests on:
- **Internal corpus:** P14's hand-crafted T1--T11 attack taxonomy (T3 multi-turn goal hijacking; T3e canary-server-routed exfiltration variant).
- **External benchmark:** AgentDojo (`important_instructions` tool-output injection), single-turn class.
- **Defended-agent coverage:** Anthropic Claude (Haiku 4.5, Sonnet 4.6, Opus 4.6, Opus 4.7), OpenAI GPT-4o-mini / GPT-4o, and (post Tests 20 / 23) Bedrock-hosted Qwen3 variants.
- **Metrics:** `hijackSucceeded` (canary-in-context, permissive) vs. `exfiltrationDetected` (canary-server POST, strict).

Reviewer-flag risks:
1. **One-corpus external validation.** Only AgentDojo. Adding a second external corpus consolidates the cross-vendor claim.
2. **Hand-crafted T1--T11 corpus.** Limited diversity vs. fuzzing-generated payloads; reviewer can argue overfit-to-corpus.
3. **§2 Related Work missing 2025--2026 runtime defences.** ClawGuard, PRISM, DRIFT, AgentSentry, AttriGuard, ToolSafe, ShieldAgent are all dredd-adjacent and need positioning.

## Prioritised recommendation

| Rank | Item | Where it goes in P15 | Engineering effort |
|---:|---|---|---|
| 1 | **MT-AgentRisk** run on Claude / OpenAI / Qwen | New §3.8 third external benchmark | ~1 week (Test 24) |
| 2 | **ClawGuard / OpenClaw / DRIFT** comparison | §2 related work table; §4 positioning | ~1 day reading + writing |
| 3 | **AgentLAB** pilot on Sonnet 4.6 / Opus 4.7 | §3.7 cross-corpus extension | ~3--4 days |
| 4 | **AgentVigil** fuzzing gen | §4.6 Future Work paragraph | ~2 hours writing |
| 5 | **AgentSentry / AttriGuard** | §2 related work paragraph | ~half day |

## Six approach families

### 1. Layered Governance Architecture (competing defence)
- **Reference:** Governance Architecture for Autonomous Agent Systems (arXiv:2603.07191, 2026)
- **Mechanism:** sandboxed OS container + intent-verifier LLM + signed capability token + append-only audit log.
- **Reported:** 96% interception, ~18 ms overhead.
- **P15 fit:** §2 Related Work — heavier than dredd's hook; useful contrast on the "defence-in-depth vs. single-point-gate" axis.

### 2. Runtime Rule-Based Interception (direct dredd competitors)
- **ClawGuard** [arXiv:2604.11790, 2026]: runtime hook + indirect-injection focus; **100% success on AgentDojo**, 50--84% ASR reduction on SkillInject.
- **OpenClaw PRISM** [arXiv:2603.11853, 2026]: zero-fork runtime layer; 0.955 block rate on 80-case benchmark.
- **DRIFT** [arXiv:2506.12104, 2025]: dynamic rule-based + injection isolation.
- **P15 fit:** §2 Related Work table — direct positioning. ClawGuard's 100% AgentDojo number is the headline P15 must address.

### 3. Counterfactual Causal Diagnosis (alternative defence philosophy)
- **AgentSentry** [arXiv:2602.22724, 2026]: temporal causal + context purification; 0% ASR all families; +20.8--33.6 pp utility under attack.
- **AttriGuard** [arXiv:2603.10749, 2026]: causal attribution; 0% ASR static attacks, ~3% utility loss.
- **Mechanism:** re-run the same step with masked inputs; compare tool calls; flag mismatch.
- **P15 fit:** §2 paragraph contrasting dredd's intent-tracking judge with re-execution-and-compare. Heavier per-call cost (2x inference).

### 4. Multi-Turn Attack Benchmarks (highest-value evaluation addition)
- **AgentLAB** [arXiv:2602.16901, 2026]: long-horizon attacks; >70% average ASR on GPT-5.1; jump from 62.5%→79.9% one-shot vs. multi-turn.
- **MT-AgentRisk / "Unsafer in Many Turns"** [arXiv:2602.13379, 2026]: 16% overall ASR increase; up to 27% on Claude 4.5 Sonnet.
- **Bad-ACTS** [arXiv:2508.16481, 2025]: adversarially-induced harms.
- **InjecAgent** (paper text mentions but not listed in the 113-paper return).
- **P15 fit:** §3.8 third external benchmark. Direct multi-turn measurement matches T3/T3e attack class. MT-AgentRisk explicitly covers Claude 4.5 Sonnet — direct cross-reference for §3.6 / §3.7.

### 5. Learned Guardrail Classifier (alternative defence)
- **ToolSafe TS-Guard** [arXiv:2601.10156, 2026]: fine-tuned Qwen2.5-7B guardrail; 94.97% accuracy on ASB-Traj; cuts unsafe tool calls up to 65%.
- **ShieldAgent** [arXiv:2503.22738, 2025]: verifiable safety policy reasoning; 90.1% recall, +11.3 pp over prior guardrails.
- **AgentDoG** (mentioned in survey, not separately cited).
- **P15 fit:** §2 paragraph on guardrail-classifier alternative; argument for why dredd's prompt-v2 catalogue + LLM judge is preferable to fine-tuned classifier (no labelled trajectories required, vendor-portable).

### 6. Automated Red-Team Fuzzing (corpus-diversity addition)
- **AgentVigil** [arXiv:2505.05849, 2025]: black-box MCTS-based fuzzer; 71% success on AgentDojo (o3-mini); 70% on VWA-adv (GPT-4o); nearly doubles baselines.
- **DREAM** [arXiv:2512.19016, 2025]: knowledge-graph + dynamic environment red-teaming; >70% success on 8/12 models.
- **P15 fit:** §4.6 Future Work — addresses "limited hand-crafted corpus" reviewer critique. Could also seed a Test 25 future-work pilot to measure dredd's robustness against fuzzed payloads.

## Citation verification policy

Per CLAUDE.md: every citation must be a real, verifiable paper. Several of these arXiv IDs are claimed-2026 — verify each via `parallel_web.py extract` against `arxiv.org` before adding to `p15.bib`. Preserve the explore-approaches output in `sources/research_<date>_external_tests.md` (TODO).

## Decision

Top 3 receive a `deep_dive` pass to surface mechanism / hyperparameters / failure modes / feasibility verdict before any test-plan or paper-text work:
1. MT-AgentRisk
2. ClawGuard
3. AgentLAB

---

# Top-3 Deep Dives (Paper Lantern, 2026-04-26)

## 1. MT-AgentRisk ("Unsafer in Many Turns") — verdict: PROTOTYPE

**Citation:** Unsafer in Many Turns: Benchmarking and Defending Multi-Turn Safety Risks in Tool-Using Agents (arXiv:2602.13379, 2026)

**Mechanism.** 365 curated scenarios that turn single-turn harmful prompts into multi-turn attack sequences across five tool surfaces: filesystem, browser, PostgreSQL, Notion, terminal. Attack chains are built across two dimensions — Format (extra steps / task splitting) and Method (intent wrapping / tool remapping / sub-goal composition / identity transformation). Scoring: a separate LLM judge (paper used GPT-4.1, temp=0) labels each transcript as COMPLETE (attack succeeded), REJECT (agent refused), or FAILED (agent stopped early).

**Reported headline:** average 16% ASR increase vs. single-turn baselines; **27% jump for Claude 4.5 Sonnet**, 23% for Qwen3-Coder.

**Integration cost.** Driver wraps PreToolUse hook; loops user message → agent → tool sandbox → tool output → next turn until scenario end. Comparable to AgentDojo's `--defense` flag. Estimated ~$200 / ~3,600 LLM calls for full 365-scenario run.

**Key hyperparameters:**
- judge temperature = 0 (CRITICAL — needed for reproducible labels)
- max_tokens (judge) = 2048

**Top failure modes:**
- *Tool-API mismatch:* small differences in tool error messages cause judge mis-classification → wrap tools to match exact benchmark signatures.
- *Sandbox leakage:* agent reaches real filesystem instead of sandbox → enforce chroot/container isolation.

**P15 fit.** STRONG. Multi-turn, tool-grounded, public split, explicit Claude 4.5 Sonnet measurements, judge-as-scorer pattern matches dredd's existing infrastructure. Paper-Lantern flags pilot of 10 scenarios first to verify integration before full run.

**Recommended action:** **draft Test 24 plan** for 10-scenario pilot → 365-scenario full run on Claude (Haiku 4.5 / Sonnet 4.6 / Opus 4.7), GPT-4o-mini, and one Bedrock-Qwen variant.

## 2. ClawGuard — verdict: PROTOTYPE (as comparator, not as defence we'd deploy)

**Citation:** ClawGuard: A Runtime Security Framework for Tool-Augmented LLM Agents Against Indirect Prompt Injection (arXiv:2604.11790, 2026)

**Mechanism.** Middleware between agent and tool with three layers:
1. **Content Sanitizer** — regex blacklist + Base64/hex normalisation on tool args and tool outputs.
2. **Rule Evaluator** — fixed `R_base` blacklist (e.g., `(?i)rm\s+-rf`, `(?i)curl\s+http`) merged with auto-generated `R_task` JSON (allowed_domains, allowed_paths, allowed_commands), generated once per task by a small LLM (paper used Llama-2-7B).
3. **User-approval gate** for ambiguous calls; append-only audit log.

**Reported headline:** 100% defence success on AgentDojo, 50--84% ASR reduction on SkillInject, 74.9--75.8% on MCPSafeBench. **Important caveat:** paper does NOT disclose the AgentDojo task-attack split used. Likely not directly comparable to dredd's Tests 12/17 (~234 user-task × attack pairings).

**Key differences vs dredd:**
| Axis | ClawGuard | dredd |
|---|---|---|
| Decision layer | Regex + rule list + small LLM rule-induction | Cohere v4 embedding drift + Sonnet 4.6 LLM judge |
| Input scope | Tool args + tool outputs | Full PreToolUse decision context (originating task + proposed action) |
| User interaction | Optional gate for ambiguous calls | Optional `review` threshold (analogous) |
| Coverage gap | Content-misleading attacks where injection lives in agent's *reasoning trace*, not tool I/O | Same gap (judge sees tool-call surface, not internal reasoning) |
| Per-task setup cost | One LLM rule-induction call (~1--2s) | None (judge runs per tool-call, not per task) |

**§2 positioning angle.** ClawGuard's regex+rule approach is *content-pattern* based; dredd's judge is *intent-consistency* based. The two are complementary: regex catches known dangerous patterns; intent-consistency catches semantically-coherent goal hijacks that pattern-matching would miss. ClawGuard's 100% AgentDojo number isn't directly comparable to dredd's --28pp ASR drop on GPT-4o-mini until we know its split, but the *mechanism difference* is the more interesting point for §2.

**Recommended action:** **§2 Related Work paragraph + comparator table.** No re-run of ClawGuard ourselves — too much engineering for a comparison the paper can make from published numbers. Cite ClawGuard, OpenClaw PRISM, ClawKeeper, DRIFT as the runtime-rule-interception family.

## 3. AgentLAB — verdict: PROTOTYPE

**Citation:** AgentLAB: Benchmarking LLM Agents against Long-Horizon Attacks (arXiv:2602.16901, 2026)

**Mechanism.** 644 test cases × 28 simulated environments (web nav, code execution, personal assistance). Splits red-team test into four parts: target agent + LLM, mutable environment, NL task description, adversarial plan spread across multiple turns. Tracks full trajectory; external LLM judge decides if malicious goal achieved. Tool surface exposed via FastAPI + Ray-based parallel scheduler.

**Reported headline:** >70% ASR on GPT-5.1; 62.5%→79.9% one-shot vs. multi-turn (GPT-4o); up to 96% on Qwen3 tool-chaining. Attack horizon: 4--8 turns, **matches T3/T3e exactly**.

**Integration cost.** Heaviest of the three. Requires:
- Wrapping dredd's PreToolUse hook into AgentLAB's FastAPI `/tool_call` endpoint contract.
- Ray-based runner for parallel scenarios.
- Replacing AgentLAB's default judge (GPT-4.1) with Sonnet 4.6 (compatibility not validated by AgentLAB authors but should work — both are high-context, function-calling LLMs).
- Random-seeded train/val/test split (paper doesn't prescribe; 70/15/15 standard).
- Estimated full-run cost ~$200; pilot of 20 cases ~$10.

**Key hyperparameters:**
- max_turns = 8 (CRITICAL — matches T3/T3e horizon exactly)
- judge_temperature = 0 (CRITICAL)
- tool_call_timeout = 30s (ROBUST default)

**Top failure modes:**
- *Judge misalignment:* generic LLM judge marks benign runs as attacks → sample 10 trajectories, manually verify, tighten judge prompt.
- *PreToolUse hook bypass:* attacks succeed because hook doesn't filter the specific argument patterns AgentLAB uses → log raw failed-case args, extend hook patterns.
- *Cost overrun:* drop to GPT-4o-mini judge or 50% scenario sample.

**P15 fit.** STRONG but heavier engineering than MT-AgentRisk. AgentLAB's horizon (4--8 turns) is an exact T3/T3e match, which is the most direct cross-corpus corroboration we can get. Trade-off: FastAPI + Ray integration is more complex than MT-AgentRisk's single-driver approach.

**Recommended action:** **Test 25 plan** as a follow-up after Test 24 (MT-AgentRisk) lands. Same defended-agent matrix; different attack-class corpus; tighter cross-corpus argument.

---

## Recommendation summary

| Item | Engineering | Cost | Plan slot | Priority |
|---|---|---|---|---:|
| MT-AgentRisk full run | Driver + tool sandbox (~1 week) | ~$200 | Test 24 | 1 |
| ClawGuard / OpenClaw / DRIFT §2 | Reading + writing only | $0 | Paper revision | 2 |
| AgentLAB pilot + full run | FastAPI wrap + Ray (~2 weeks) | ~$200 | Test 25 | 3 |
| AgentVigil §4.6 mention | Writing only | $0 | Paper revision | 4 |
| AgentSentry / AttriGuard §2 | Reading + writing | $0 | Paper revision | 5 |

**Sequencing:** Tests 24 + 25 are independent of Tests 19--23 (different attack classes, different runners). They can run after Tests 19--23 settle, or in parallel if cluster capacity permits. Paper-revision items (ClawGuard / AgentVigil / AgentSentry) can be drafted now without waiting on any execution.
