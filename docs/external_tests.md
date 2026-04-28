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

## Citation verification status

Per CLAUDE.md: every citation must be a real, verifiable paper. Verification done via WebFetch on arxiv.org abstract pages (2026-04-26) — `PARALLEL_API_KEY` not set in env; WebFetch used as last-resort fallback.

| arXiv ID | Title (short) | Verified? | Source extract record |
|---|---|:---:|---|
| 2602.13379 | MT-AgentRisk / ToolShield (Li et al.) | ✓ 2026-04-26 | `p15/sources/extract_20260426_arxiv_2602_13379.md` |
| 2604.11790 | ClawGuard (Zhao et al.) | ✓ 2026-04-26 | `p15/sources/extract_20260426_arxiv_2604_11790.md` |
| 2602.16901 | AgentLAB (Jiang et al.) | ✓ 2026-04-26 | `p15/sources/extract_20260426_arxiv_2602_16901.md` |
| 2603.11853 | OpenClaw PRISM (F. Li) | ✓ 2026-04-26 | `JudgeAIDredd/docs/competitors.md` (BibTeX inline below) |
| 2506.12104 | DRIFT (Li, Liu, Chiu, Li, Zhang, Xiao) | ✓ 2026-04-26 | `JudgeAIDredd/docs/competitors.md` |
| 2602.22724 | AgentSentry (Zhang, Xu, Wang et al.) | ✓ 2026-04-26 | `JudgeAIDredd/docs/competitors.md` |
| 2603.10749 | AttriGuard (He, Zhu, Li et al.) | ✓ 2026-04-26 | `JudgeAIDredd/docs/competitors.md` |
| 2601.10156 | ToolSafe TS-Guard (Mou, Xue, Li et al.) | ✓ 2026-04-26 | `JudgeAIDredd/docs/competitors.md` |
| 2603.07191 | Layered Governance Architecture (Y. Ge) | ✓ 2026-04-26 | curl arxiv metadata |
| 2508.16481 | BAD-ACTS (Nöther, Singla, Radanovic) | ✓ 2026-04-26 | curl arxiv metadata |
| 2503.22738 | ShieldAgent (Chen, Kang, B. Li) | ✓ 2026-04-26 | curl arxiv metadata |
| 2505.05849 | AgentVigil (Wang, Siu et al.) | ✓ 2026-04-26 | curl arxiv metadata |
| 2512.19016 | DREAM (Lu, Gu et al.) | ✓ 2026-04-26 | curl arxiv metadata |
| 2603.24414 | ClawKeeper (Liu, Li et al.) | ✓ 2026-04-26 | curl arxiv metadata |
| 2510.05244 | **Indirect Prompt Injections "firewall"** (Bhagwatkar et al.) — CLAIMS PERFECT SECURITY ON AGENTDOJO + 3 BENCHMARKS | ✓ 2026-04-26 | curl arxiv metadata |

### Additional verified BibTeX entries

```bibtex
@misc{bhagwatkar2025firewall,
  title  = {Indirect Prompt Injections: Are Firewalls All You Need, or Stronger Benchmarks?},
  author = {Bhagwatkar, Rishika and Kasa, Kevin and Puri, Abhay and Huang, Gabriel and Rish, Irina and Taylor, Graham W. and Dvijotham, Krishnamurthy and Lacoste, Alexandre},
  year   = {2025}, month = oct,
  eprint = {2510.05244}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2510.05244},
  url    = {https://arxiv.org/abs/2510.05244}
}

@misc{ge2026lga,
  title  = {Governance Architecture for Autonomous Agent Systems: Threats, Framework, and Engineering Practice},
  author = {Ge, Yuxu},
  year   = {2026}, month = mar,
  eprint = {2603.07191}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2603.07191},
  url    = {https://arxiv.org/abs/2603.07191}
}

@misc{nother2025badacts,
  title  = {Benchmarking the Robustness of Agentic Systems to Adversarially-Induced Harms},
  author = {N{\"o}ther, Jonathan and Singla, Adish and Radanovic, Goran},
  year   = {2025}, month = aug,
  eprint = {2508.16481}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2508.16481},
  url    = {https://arxiv.org/abs/2508.16481}
}

@misc{chen2025shieldagent,
  title  = {{ShieldAgent}: Shielding Agents via Verifiable Safety Policy Reasoning},
  author = {Chen, Zhaorun and Kang, Mintong and Li, Bo},
  year   = {2025}, month = mar,
  eprint = {2503.22738}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2503.22738},
  url    = {https://arxiv.org/abs/2503.22738}
}

@misc{wang2025agentvigil,
  title  = {{AgentVigil}: Generic Black-Box Red-teaming for Indirect Prompt Injection against {LLM} Agents},
  author = {Wang, Zhun and Siu, Vincent and Ye, Zhe and Shi, Tianneng and Nie, Yuzhou and Zhao, Xuandong and Wang, Chenguang and Guo, Wenbo and Song, Dawn},
  year   = {2025}, month = may,
  eprint = {2505.05849}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2505.05849},
  url    = {https://arxiv.org/abs/2505.05849}
}

@misc{lu2025dream,
  title  = {{DREAM}: Dynamic Red-teaming across Environments for {AI} Models},
  author = {Lu, Liming and Gu, Xiang and Huang, Junyu and Du, Jiawei and Zheng, Xu and Liu, Yunhuai and Zhou, Yongbin and Pang, Shuchao},
  year   = {2025}, month = dec,
  eprint = {2512.19016}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2512.19016},
  url    = {https://arxiv.org/abs/2512.19016}
}

@misc{liu2026clawkeeper,
  title  = {{ClawKeeper}: Comprehensive Safety Protection for {OpenClaw} Agents Through Skills, Plugins, and Watchers},
  author = {Liu, Songyang and Li, Chaozhuo and Wang, Chenxu and Hou, Jinyu and Chen, Zejian and Zhang, Litian and Liu, Zheng and Ye, Qiwei and Hei, Yiming and Zhang, Xi and Wang, Zhongyuan},
  year   = {2026}, month = mar,
  eprint = {2603.24414}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2603.24414},
  url    = {https://arxiv.org/abs/2603.24414}
}
```

**All 15 candidate citations now verified.** Ready for selective addition to `p15.bib` for §1.7 / §4.4 / §4.6 references.

### Verified BibTeX entries for the §2-Related-Work runtime-defence family

```bibtex
@misc{li2026openclaw_prism,
  title  = {{OpenClaw} {PRISM}: A Zero-Fork, Defense-in-Depth Runtime Security Layer for Tool-Augmented {LLM} Agents},
  author = {Li, Frank},
  year   = {2026}, month = mar,
  eprint = {2603.11853}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2603.11853},
  url    = {https://arxiv.org/abs/2603.11853}
}

@misc{li2025drift,
  title  = {{DRIFT}: Dynamic Rule-Based Defense with Injection Isolation for Securing {LLM} Agents},
  author = {Li, Hao and Liu, Xiaogeng and Chiu, Hung-Chun and Li, Dianqi and Zhang, Ning and Xiao, Chaowei},
  year   = {2025}, month = jun,
  eprint = {2506.12104}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2506.12104},
  url    = {https://arxiv.org/abs/2506.12104}
}

@misc{zhang2026agentsentry,
  title  = {{AgentSentry}: Mitigating Indirect Prompt Injection in {LLM} Agents via Temporal Causal Diagnostics and Context Purification},
  author = {Zhang, Tian and Xu, Yiwei and Wang, Juan and Guo, Keyan and Xu, Xiaoyang and Xiao, Bowen and Guan, Quanlong and Fan, Jinlin and Liu, Jiawei and Liu, Zhiquan and Hu, Hongxin},
  year   = {2026}, month = feb,
  eprint = {2602.22724}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2602.22724},
  url    = {https://arxiv.org/abs/2602.22724}
}

@misc{he2026attriguard,
  title  = {{AttriGuard}: Defeating Indirect Prompt Injection in {LLM} Agents via Causal Attribution of Tool Invocations},
  author = {He, Yu and Zhu, Haozhe and Li, Yiming and Shao, Shuo and Yao, Hongwei and Liu, Zhihao and Qin, Zhan},
  year   = {2026}, month = mar,
  eprint = {2603.10749}, archivePrefix = {arXiv}, primaryClass = {cs.CR},
  doi    = {10.48550/arXiv.2603.10749},
  url    = {https://arxiv.org/abs/2603.10749}
}

@misc{mou2026toolsafe,
  title  = {{ToolSafe}: Enhancing Tool Invocation Safety of {LLM}-based Agents via Proactive Step-level Guardrail and Feedback},
  author = {Mou, Yutao and Xue, Zhangchi and Li, Lijun and Liu, Peiyang and Zhang, Shikun and Ye, Wei and Shao, Jing},
  year   = {2026}, month = jan,
  eprint = {2601.10156}, archivePrefix = {arXiv}, primaryClass = {cs.CL},
  doi    = {10.48550/arXiv.2601.10156},
  url    = {https://arxiv.org/abs/2601.10156}
}
```

**Verification note:** WebFetch's "fabricated" verdict on 2603.11853 was a false positive — its training cutoff is pre-2026 so it flagged the future-relative-to-training-data submission date. Direct arxiv.org metadata via curl confirmed the paper. Same approach (curl on arxiv.org) used for 2506.12104 / 2602.22724 / 2603.10749 / 2601.10156.

**Verify any item before adding to `p15.bib`.** Verified BibTeX entries are inlined in each source extract record above.

## New findings from verification (not in original explore_approaches output)

### Finding A: arXiv:2602.13379 also proposes a *defence* — ToolShield

The Paper Lantern deep dive treated 2602.13379 as a benchmark only (MT-AgentRisk). The arxiv abstract surfaces that the **same paper also proposes ToolShield**, characterised as *training-free, tool-agnostic, self-exploration*, reducing ASR by 30% on average. This puts the paper in two categories:

1. **External benchmark** (Test 24 evaluation use)
2. **Competitor defence** (§2 Related Work — alongside ClawGuard, AgentSentry, ToolSafe, ShieldAgent)

ToolShield's "training-free + self-exploration" mechanism is mechanistically distinct from dredd's PreToolUse intent-tracking judge — worth a one-paragraph contrast in §2 once the §2 Related Work pass happens.

### Finding B: ClawGuard names three attack channels — broader than AgentDojo's framing

ClawGuard (2604.11790) explicitly targets three indirect-prompt-injection channels:
1. **Web and local content injection** — overlaps with AgentDojo's `important_instructions`.
2. **MCP server injection** — Model Context Protocol server-mediated injection. Not covered by P15.
3. **Skill file injection** — agent-skill / system-prompt-side injection. Not covered by P15.

This matters for §2 + §4.6: P15's defence operates at the PreToolUse-tool-call gate (channel 1); MCP-server and skill-file channels are out of scope and become Future Work items rather than competing-coverage gaps.

### Finding C: AgentLAB has five attack types (not three environment categories)

The Paper Lantern deep dive listed "web navigation, code execution, personal assistance" — these are **environment categories**, not attack types. The verified abstract names **five distinct attack types**:

| Attack type | Mapping to P14 / P15 |
|---|---|
| Intent hijacking | Direct overlap with P14 T3 multi-turn goal hijacking |
| Tool chaining | Partial overlap with T3.4 (tool-call composition) |
| Task injection | Overlaps with AgentDojo's `important_instructions` |
| Objective drifting | New axis; closest analogue P14 T5 |
| Memory poisoning | **New axis; not covered by P14 / P15 corpus or AgentDojo. dredd's PreToolUse gate does not directly defend (judge sees tool-call-vs-task surface, not agent-internal memory).** |

Test 25's per-attack-type breakdown gives P15 a per-class characterisation of dredd's coverage — particularly the memory-poisoning row, which is a clean honest "this attack class is out of scope of the proposed defence" finding rather than a defence failure.

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
