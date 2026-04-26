# Competitor Landscape — Tool-Call Approval and Adjacent Defences

**Date:** 2026-04-25
**Scope:** alternatives and adjacent approaches to JudgeAIDredd's runtime tool-call approval architecture, organised by defence mechanism. For deployer-facing recommendations see the trade-off table at the end.

JudgeAIDredd's positioning is **runtime per-tool-call approval in a context isolated from the agent's conversation**, fired at the PreToolUse decision point. The alternatives below sit at different layers of the stack — model-internal, capability-restriction at session start, agent-loop wrappers, OS-level sandboxing, evaluation-only — and are mostly complementary rather than directly competing with dredd. The closest architectural comparator is CaMeL.

---

## Capability-restriction (closest direct competitors)

These defences restrict what the agent is *allowed to do* at session start, rather than evaluating individual tool calls at run time.

### CaMeL (Google DeepMind, 2025)

- **Mechanism:** dual-LLM quoted-data pattern. Trusted instructions and untrusted content are kept in separate contexts; the agent cannot interleave them.
- **Reported numbers:** 77% benign utility / 0% escapes on AgentDojo at GPT-4o. Best-published ASR in the comparator set.
- **Trade-off:** restricts agent capability; some legitimate tasks become harder or impossible. Provable control-flow guarantees on what survives.
- **Relationship to dredd:** **most direct architectural comparator.** CaMeL achieves high precision (0% escapes) at the cost of recall on benign tasks; dredd achieves higher recall on catalogued pretexts at higher benign utility cost. A hybrid (CaMeL session-start restriction + dredd PreToolUse approval) is the future-work item in P15 §4.6.

### IsolateGPT (NDSS 2025, Wu et al.)

- **Mechanism:** hub-and-spoke architecture for multi-app LLM agents. Each spoke gets isolated execution context.
- **Trade-off:** focused on multi-app composition rather than single-agent goal hijacking; not directly applicable to coding-agent deployments.
- **Relationship to dredd:** orthogonal — different threat model.

### Mandatory Access Control by Data Type (Jacob et al. 2025)

- **Mechanism:** static MAC policy that restricts which trust boundaries the agent can cross.
- **Trade-off:** policy must be authored at deployment time and covers known categories; novel data flows fall outside.
- **Relationship to dredd:** complementary — dredd handles the runtime check on novel pretexts that the static policy didn't anticipate.

---

## Runtime tool-call interception — dredd's architectural family (closest direct competitors)

These defences fire at the *same* PreToolUse decision point as dredd: before each tool call executes, decide allow / deny / escalate based on some signal computed from the proposed call. The five papers below were all published in **2025--2026** as the field converged on this architecture independently. They split into four sub-families by *what signal the defence uses to decide*.

### Sub-family A: Rule-based interception (regex blacklist + auto-induced allowlist)

Defences that compile static patterns plus task-specific allowlists into a deterministic gate. Fastest of the four sub-families; weakest semantic understanding.

#### ClawGuard (Zhao, Li, Zhang, Sun 2026; arXiv:2604.11790)

- **Mechanism:** middleware between agent and tools with three stages — (i) regex sanitiser on tool arguments and tool outputs, including Base64/hex normalisation; (ii) two-tier rule set: fixed `R_base` blacklist (e.g., `(?i)rm\s+-rf`, `(?i)curl\s+http`) + task-specific `R_task` JSON (allowed_domains, allowed_paths, allowed_commands) auto-induced by a small helper LLM (paper used Llama-2-7B) once per task; (iii) optional user-approval gate for ambiguous calls; append-only audit log with HMAC integrity.
- **Coverage:** explicitly targets three indirect-injection channels: (1) web/local content injection, (2) MCP server injection, (3) skill file injection. P15 currently covers only (1).
- **Reported numbers:** 100% defence success on AgentDojo (split not disclosed); 50--84% ASR reduction on SkillInject; 74.9--75.8% on MCPSafeBench.
- **Trade-off:** deterministic, auditable, fast. Gaps on stealthy encodings if regex coverage misses; rule-induction quality depends on helper LLM; reasoning-trace injections (where the malicious instruction appears only in the agent's own thinking, not in tool I/O) bypass the gate entirely.
- **Relationship to dredd:** *content-pattern* matching at the same gate dredd uses for *intent-consistency* matching. The two are **complementary**: regex catches known dangerous patterns the judge might rationalise; intent-consistency catches semantically-coherent goal hijacks where every individual tool call looks pattern-clean. ClawGuard's 100% AgentDojo headline is not directly comparable to dredd's --28pp ASR drop on GPT-4o-mini until the split is disclosed. **The mechanism difference is the more substantive §2 contrast point.**

#### OpenClaw PRISM (F. Li 2026; arXiv:2603.11853)

- **Mechanism:** zero-fork in-process plugin (plus optional sidecar services) that distributes enforcement across **ten lifecycle hooks** spanning message ingress, prompt construction, tool execution, tool-result persistence, outbound messaging, sub-agent spawning, gateway startup. Hybrid heuristic + LLM scanning; conversation- and session-scoped risk accumulation with TTL-based decay; policy-enforced controls over tools, paths, private networks, domain tiers, and outbound secret patterns; tamper-evident audit plane with hot-reloadable policy management.
- **Reported numbers:** the paper reports preliminary benchmark results on curated same-slice experiments and operational microbenchmarks; no headline single-number ASR figure in the abstract.
- **Trade-off:** production-deployment-orientated (ten hooks vs. dredd's one); breadth at the cost of evaluation depth; risk accumulation introduces a calibration knob (TTL) that a deployer must tune.
- **Relationship to dredd:** **broader gate surface (10 hooks) than dredd's 1 hook (PreToolUse).** dredd's narrower scope is intentional — concentrating evaluation cost on the one decision point that gates real-world side effects. PRISM's risk-accumulation idea (multi-turn drift across the session, with TTL decay) overlaps conceptually with dredd's intent-tracking judge state but mechanises it differently: PRISM accumulates rule-engine flags; dredd's judge re-evaluates each call against the *original* task. Composable in principle.

#### DRIFT (H. Li, Liu, Chiu, D. Li, Zhang, Xiao 2025; arXiv:2506.12104)

- **Mechanism:** dynamic rule-based defence with *injection isolation*. Static or predefined policies augmented with a runtime mechanism that detects when injected content has slipped into the agent's context and isolates that content from downstream decision-making.
- **Reported numbers:** abstract is mechanism-focused; specific ASR numbers not in abstract.
- **Trade-off:** isolation requires identifying *which* part of the context is untrusted — a well-known hard problem (the same problem CaMeL solves with the dual-LLM quoted-data pattern).
- **Relationship to dredd:** **dredd does not isolate injected content** — its judge sees the full proposed-action surface and decides on the call's intent-consistency directly. DRIFT's isolation is a *prevention* approach (don't let injection influence decisions); dredd's judge is a *detection* approach (let the agent be influenced, then catch the off-task tool call). The two could compose: DRIFT-style isolation upstream, dredd-style judge gate downstream.

### Sub-family B: Counterfactual / causal diagnostics (re-execute and compare)

Defences that run the agent step twice — once with the suspect input, once with it masked — and compare the two tool calls to detect injection-driven divergence.

#### AgentSentry (Zhang, Xu, Wang, Guo, Xu, Xiao, Guan, Fan, Liu, Liu, Hu 2026; arXiv:2602.22724)

- **Mechanism:** "temporal causal diagnostics" — when a tool returns suspicious content, replay the same step with the suspicious content masked, compare the resulting tool calls. Material divergence flags indirect prompt injection. Includes "context purification" to remove the offending content before continuing.
- **Reported numbers:** 0% ASR on all tested attack families; +20.8 to +33.6 pp utility-under-attack improvement.
- **Trade-off:** **doubles inference cost per tool call** (two forward passes); requires reliable masking strategy; latency-sensitive.
- **Relationship to dredd:** **fundamentally different evaluation paradigm.** Dredd uses a *separate context-isolated judge* (one extra LLM call per tool call); AgentSentry uses *the same model re-executed with masked inputs* (one extra agent forward pass). AgentSentry's approach is theoretically stronger (catches anything that causes input-output divergence regardless of policy) but **2x cost** vs. dredd's ~1.5x cost. AgentSentry's 0% ASR is a published headline that competes directly with CaMeL's 0% escapes; both achieve precision through fundamentally different mechanisms.

#### AttriGuard (He, Zhu, Li, Shao, Yao, Liu, Qin 2026; arXiv:2603.10749)

- **Mechanism:** "action-level causal attribution" — for each proposed tool call, attribute *why* it was produced. Distinguishes calls supported by user intent from calls causally driven by untrusted tool-output content. The framing is explicitly *not* input-level semantic discrimination (which fails on unseen payloads).
- **Reported numbers:** 0% ASR on static attacks; ~3% utility loss.
- **Trade-off:** causal-attribution computation requires gradient-based or perturbation-based explainability primitives; per-call cost varies by attribution method.
- **Relationship to dredd:** **architecturally adjacent.** AttriGuard asks "why is the agent making this tool call?" — which is **the same question dredd's judge prompt v2 asks**. The mechanisms differ (AttriGuard: causal attribution over the agent's internal state; dredd: external LLM judge reasoning over visible tool-call vs. originating-task surface). Both target the *intent-consistency* signal rather than content-pattern matching. AttriGuard requires access to the agent's internals (gradients / attention); dredd works black-box. **For non-Anthropic / closed-source agents, dredd's black-box approach is strictly more deployable than AttriGuard's white-box approach.**

### Sub-family C: Training-free self-exploration

Defences that rely on the agent itself running additional self-checks rather than an external defence layer.

#### ToolShield (within Li, Yu, Pan, Sun, Li, Song, Lin, Shi 2026; arXiv:2602.13379)

- **Mechanism:** "training-free, tool-agnostic, self-exploration" — the agent is prompted to perform additional self-consistency checks before committing to a tool call. No external classifier, no fine-tuning, no rule engine.
- **Reported numbers:** 30% average ASR reduction on the MT-AgentRisk benchmark (from the same paper).
- **Trade-off:** asks the agent that has already been compromised (via injection) to police itself. **Same surface that the injection co-opted is the surface the defence relies on** — analogous to LlamaFirewall's Agent Alignment Checks (covered below).
- **Relationship to dredd:** **dredd's design specifically rejects this approach.** P15 §3.4 notes that defences which read the agent's own reasoning are subject to capture by the same injection. Dredd's judge runs in a context **isolated from** the agent's conversation; ToolShield runs *inside* the agent's conversation. The contrast is the cleanest single-paragraph §2 distinction.

### Sub-family D: Learned guardrail classifier (fine-tuned safety model)

Defences that train a separate small model on labelled unsafe trajectories and run it as a guardrail.

#### ToolSafe / TS-Guard (Mou, Xue, Li, Liu, Zhang, Ye, Shao 2026; arXiv:2601.10156)

- **Mechanism:** TS-Bench (a labelled benchmark of step-level tool invocation safety) plus TS-Guard, a guardrail model trained via multi-task reinforcement learning. Proactively detects unsafe tool invocations before execution; provides feedback for the agent to revise its plan.
- **Reported numbers:** 94.97% accuracy on ASB-Traj benchmark; up to 65% reduction in unsafe tool calls.
- **Trade-off:** **requires labelled unsafe trajectories** for the RL training stage. Quality of labels caps the guardrail's coverage; novel attack patterns outside the training distribution likely missed. Also adds a fine-tuned model to the deployment stack — cost, ops, and vendor-lock-in.
- **Relationship to dredd:** **dredd avoids the labelled-data requirement entirely.** dredd's prompt v2 catalogue is hand-authored from the P14 attack taxonomy; the LLM judge generalises to unseen patterns via the catalogue's *patterns-of-attack* framing rather than per-instance labels. TS-Guard achieves higher accuracy on its training distribution; dredd is more vendor-portable and easier to update (one prompt-edit vs. one re-training run). On open-weights agents (Qwen) the gap narrows because TS-Guard can be co-deployed; on commercial agents (Claude, GPT-4o), running TS-Guard means hosting an additional 7B-class model, which is the cost dredd's prompt-only design avoids.

### Summary of dredd vs. runtime-interception family

| Defence | Decision signal | Stateful across turns? | Per-call cost | White-box vs. black-box | Vendor-portable | Reported headline |
|---|---|:---:|:---:|---|:---:|---|
| **dredd** | LLM judge on tool-call vs. originating-task intent | ✓ (judge sees task + history) | ~1.5x (one judge call) | black-box | ✓ | --28pp ASR on AgentDojo / GPT-4o-mini |
| **ClawGuard** | Regex + auto-induced rule set | partial (R_task per task) | ~1.05x (regex+rule eval) | black-box | ✓ | 100% on AgentDojo |
| **OpenClaw PRISM** | Hybrid heuristic + LLM scan + risk accumulation | ✓ (session-scoped TTL) | varies (10 hooks) | black-box | ✓ | preliminary results only |
| **DRIFT** | Dynamic rules + injection isolation | ✓ | ~1.1x | black-box | ✓ | not in abstract |
| **AgentSentry** | Re-execute with masked input, compare | ✓ | **2x** (two forward passes) | grey-box | ✓ | 0% ASR all families |
| **AttriGuard** | Causal attribution of tool calls | partial | varies | **white-box** (gradients/attention) | restricted | 0% ASR static |
| **ToolShield** | Agent self-exploration | partial | ~1.3x (extra self-check turns) | black-box | ✓ | --30pp avg ASR |
| **ToolSafe TS-Guard** | Fine-tuned safety classifier | ✗ (per-call) | ~1.2x (classifier call) | black-box | partial (host classifier) | 94.97% accuracy |

**Key positioning takeaways for §2 / §4:**

1. **Family convergence is real.** Five 2025--2026 papers land at the same PreToolUse decision point as dredd. The contribution is no longer "the gate exists"; it is **what signal the gate uses**.
2. **dredd's black-box LLM-judge approach is in the smallest sub-family** (alone) but is the most vendor-portable. AttriGuard's white-box requirement excludes commercial agents; TS-Guard requires labelled training data; ToolShield asks the agent to police itself; rule-based approaches miss semantically-coherent attacks.
3. **AgentSentry's 0% ASR claim is the headline number P15 has to position against** alongside ClawGuard's 100% AgentDojo and CaMeL's 0% escapes. All three differ from dredd in the precision/recall/cost trade-off they accept; none dominates dredd on the full picture of (precision, recall, cost, vendor-portability, deployer-effort).
4. **Memory-poisoning (per AgentLAB taxonomy) is out-of-scope for every member of this family**, dredd included. The judge / classifier / rule engine sees the tool-call-vs-task surface, not the agent's internal memory state. Honest §4.6 Future Work item.

---

## Inline guardrails / agent-loop wrappers

These defences wrap the agent's loop with classifiers, auditors, or static analysis.

### LlamaFirewall (Meta, 2025)

- **Mechanism:** three modules wrapping the agent loop:
  - **PromptGuard** — jailbreak / prompt-injection text classifier.
  - **Agent Alignment Checks** — chain-of-thought auditor that reads the agent's own reasoning.
  - **CodeShield** — static analysis on agent-generated code.
- **Trade-off:** the Agent Alignment Checks component reads the agent's reasoning, which is precisely the surface a successful injection co-opts.
- **Relationship to dredd:** dredd specifically avoids the alignment-check approach. Dredd's judge runs in a context **isolated from** the agent's conversation and reasoning, so injections that redirect the agent cannot redirect the judge.

### NeMo Guardrails (NVIDIA)

- **Mechanism:** programmatic rules ("Colang" DSL) for LLM applications. Mostly conversational guardrails.
- **Trade-off:** rule authoring is the deployment effort; rules are rigid relative to LLM-as-a-judge runtime evaluation.
- **Relationship to dredd:** could compose at the conversation layer; dredd operates at the tool-call layer.

### LLM Guard (Protect AI)

- **Mechanism:** open-source input/output sanitisation pipeline. Classifiers for PII, prompt injection, toxic content, secrets exposure.
- **Trade-off:** classifier-based; effective on known patterns, less so on novel pretexts.
- **Relationship to dredd:** input-side classifier is complementary to dredd's tool-call-side approval.

### Lakera Guard

- **Mechanism:** commercial inline detection service for prompt injection and jailbreaks.
- **Trade-off:** classifier-based; vendor-managed model updates.
- **Relationship to dredd:** competing for budget at the input-classifier layer; dredd sits at a different point in the stack.

### Prompt Guard 2 (Meta)

- **Mechanism:** open-source classifier specifically for prompt-injection text patterns.
- **Trade-off:** narrow scope (text-pattern detection); does not evaluate tool-call semantic consistency.
- **Relationship to dredd:** input-side complement.

---

## Vendor-internal probes and safety training

Defences that live inside the model rather than as an external service.

### Anthropic's representation probes (Opus 4.7 system card)

- **Mechanism:** lightweight detectors trained on internal Claude activations, classifying prompt-injection attempts. Per the Claude Opus 4.7 system card, transitioned from earlier classifier-based detectors and *"enabled by default in many of our agentic products"*.
- **Trade-off:** model-specific (only protects Claude deployments); operates inside the model so cannot be audited or replaced by the deployer.
- **Relationship to dredd:** **composable, not competitive.** A Claude deployer running through dredd gets defence in depth: Anthropic's probes catch what they catch at the model layer; dredd catches what it catches at the PreToolUse gate. Anthropic's own Opus 4.7 system-card numbers (Shade adaptive ASR 25% even with their safeguards) show the residual window dredd targets externally.

### Constitutional AI / RLHF (Anthropic, OpenAI, Meta, ...)

- **Mechanism:** vendor-internal safety training during model development. The baseline that all wraparound defences sit on top of.
- **Trade-off:** not deployable as a separate layer; relies on the vendor.
- **Relationship to dredd:** dredd's premise (*"a strong session-start system prompt is necessary but structurally insufficient"*) is precisely about the limits of training-time defences. Trained-in safety provides the baseline; dredd targets the residual.

---

## Permission-prompt systems built into agent CLIs (the layer dredd replaces)

These are the *human approver* dredd is positioned to augment or replace.

### Claude Code permission prompts

- Interactive human approver. The defence dredd is designed to compose with (interactive mode) or replace (autonomous / SDK mode).

### Cursor allowlist / denylist

- Auto-run safety boundaries. Bypassed in 2025 via four documented techniques (Backslash Security disclosure); subsequently moved from denylist to allowlist. CVE-2025-59944 (case-sensitivity) escaped the workspace sandbox via prompt injection.

### OpenAI Codex CLI approval modes

- Including `--dangerously-bypass-approvals-and-sandbox` (aliased `--yolo`). Two of four major coding-agent CLIs name-check "dangerously" in the bypass flag itself.

### OpenAI Operator action confirmation

- Modal action confirmation in the browser-using Operator product.

### Microsoft Copilot Studio action approval

- Approval flows for Power Platform agents.

**Common limitation across all of these:** rely on the human as a reliability backstop. Subject to warning fatigue (Akhawe & Felt 2013, Felt et al. 2012, Mark et al. 2008) and disabled by auto-approve flags in a substantial fraction of real usage. Dredd's premise is that the human-as-backstop assumption breaks down at modern session lengths and autonomous deployment modes; the same PreToolUse decision point becomes the right place for an automated approver.

---

## OS-level sandboxing and privilege restriction

Constrains *what the agent can do at all*, regardless of intent.

- **gVisor, Firecracker** — kernel-level sandboxing for the agent's process.
- **Docker / Podman with capability dropping** — coarse-grained but standard. The default for most CI / cloud agent deployments today.
- **AWS Nitro Enclaves, Azure Confidential Containers** — TEE-based isolation.

**Relationship to dredd:** complementary, not competitive. OS sandboxing constrains the *blast radius*; dredd constrains *whether a specific tool call is on-task*. Production deployments should layer both.

---

## Evaluation environments (adjacent, not defences)

- **AgentDojo** (Debenedetti et al. 2024) — the benchmark dredd is evaluated against. Includes a `tool_filter` reference defence (~31% ASR on GPT-4o, ~15 pp ASR reduction) — the simplest comparator and the lowest bar.
- **AgentHarm** (Andriushchenko et al. 2025) — adversarial benchmark for harmful-action elicitation.
- **ToolEmu** (Ruan et al. 2024) — LM-emulated sandbox for safety evaluation.
- **Garak** — vulnerability scanner for LLMs (open-source).
- **PromptInject** — adversarial prompt-injection test corpus.

These define what "secure" means quantitatively but do not deploy as defences themselves.

---

## Closest academic prior art for the LLM-as-a-judge runtime layer

- **MT-Bench** (Zheng et al. 2023) — established LLM-as-a-judge as an evaluation methodology, ${>}80\%$ agreement with human preferences.
- **Gu et al. 2024 survey on LLM judges** — systematic review of judge calibration and bias.
- **Position bias** (Shi et al. 2024), **self-preference bias** (Wataoka et al. 2024) — the calibration concerns dredd's per-cell Wilson 95% CI methodology addresses.

The literature treats LLM-as-a-judge as an **offline evaluation paradigm**. Dredd's contribution is promoting it to a **runtime security control** with per-tool-call invocation, context isolation from the agent's conversation, a deterministic verdict contract (`consistent` / `drifting` / `hijacked`), and adversarial-driven prompt hardening. The judge prompt itself is the dominant calibration lever (P15 §3.4).

---

## Adjacent: jailbreak-specific defences

These target jailbreaking (model says-something-harmful) rather than goal hijacking (agent does-something-attacker-chosen). Different threat model.

- **PromptGuard / Prompt Guard 2** (Meta) — text classifier for jailbreak attempts.
- **ShieldLM** — open-source moderation model.
- **Anthropic's harmlessness classifier** — internal to Claude.

**Relationship to dredd:** orthogonal threat model. Dredd's adversarial test set targets goal-hijacking pretexts (credential exfiltration framed as security work), not jailbreaks. The two defences address different failure modes.

---

## Structural reformulation approaches

- **CaMeL's quoted-data pattern** (already covered above)
- **StruQ / Spotlighting** — structure prompts to typographically separate trusted from untrusted content. Effective on simple injections; sophisticated pretexts still pass.
- **Privilege separation by capability tokens** (academic) — agents receive scoped capability tokens at session start.

---

## Deployer trade-off table

| Operational concern | Recommended defence layer |
|---|---|
| Provable security guarantees, willing to accept ~7 pp benign utility loss | **CaMeL** |
| Lowest measured ASR on AgentDojo, OK with up to ~15 pp benign utility loss on non-coding domains | **JudgeAIDredd / tool-call approval** |
| Lowest measured ASR claim across the runtime-interception family (0%) and willing to accept ~2x inference cost | **AgentSentry** (re-execute with masked input) |
| Want a regex-style deterministic gate with auditable rules, not LLM-as-judge | **ClawGuard** or **OpenClaw PRISM** |
| Have access to the agent's gradients/attention (open-weights deployment) and want fine-grained attribution | **AttriGuard** |
| Have labelled unsafe trajectories and can host an extra 7B-class guardrail | **ToolSafe TS-Guard** |
| Want defence with zero infrastructure beyond a richer prompt | **ToolShield** (note: same agent that's been compromised polices itself; weakest of the family) |
| Running Claude in production, want zero extra deployment cost | **Anthropic's representation probes** (on by default) — but stack JudgeAIDredd on top for the residual gap (Opus 4.7 + safeguards still 25% Shade ASR per system card) |
| Coarse-grained but battle-tested isolation against unknown agent behaviour | **OS sandboxing** (gVisor, Firecracker, Nitro Enclaves) plus any of the above |
| Pre-existing CLI workflow with permission prompts | Harden the existing CLI (allowlists, dredd as auto-approval on `consistent`, escalate `drifting`/`hijacked` to the human) |
| Defence-in-depth across multiple layers | CaMeL session-start restriction + dredd PreToolUse approval + DRIFT-style isolation + OS sandbox + vendor-internal probes |
| Conversation-layer guardrails (chat moderation) | NeMo Guardrails, LLM Guard, Lakera Guard |
| Static analysis on agent-generated code | LlamaFirewall's CodeShield, GitHub Advanced Security, Semgrep |

---

## Honest positioning summary

Dredd's contribution is **not** "the only defence against prompt injection" — that would be overclaiming. It is the **runtime, context-isolated, per-tool-call approver** position in a layered defence stack.

As of 2026-04-26, dredd's *architectural* family (runtime PreToolUse interception) has converged: ClawGuard, OpenClaw PRISM, DRIFT, AgentSentry, AttriGuard, ToolShield, and ToolSafe all fire at the same gate. The differentiator is no longer "the gate exists" but **what signal the gate uses to decide**:

- **Rule-based** (ClawGuard, PRISM, DRIFT) — fast, deterministic, auditable; weak on semantically-coherent attacks where individual tool calls look pattern-clean.
- **Causal / counterfactual** (AgentSentry, AttriGuard) — strongest precision (0% ASR claims); 2x inference cost and either grey-box or white-box requirements.
- **Self-exploration** (ToolShield) — same agent polices itself; subject to capture by the same injection.
- **Learned classifier** (TS-Guard) — high accuracy on training distribution; requires labelled trajectories and an extra hosted model.
- **dredd** — black-box LLM-as-judge in a context **isolated from the agent's conversation**, evaluating tool-call-vs-originating-task intent. Vendor-portable, no labelled data, no white-box access required, no doubled inference cost. The trade-off is a single LLM-judge call per tool call (~1.5x cost) and reliance on prompt-engineering quality (the catalogue) rather than a deterministic rule set.

The most informative comparators on AgentDojo's exfiltration metric are CaMeL (capability restriction, dominates on precision) and `tool_filter` (the simplest baseline, weak on both axes). Within the runtime-interception family, **AgentSentry's 0% ASR is the headline number P15 has to position against** alongside CaMeL's 0% escapes; both achieve precision through fundamentally different mechanisms from dredd, and neither dominates dredd on the full picture of (precision, recall, cost, vendor-portability, deployer-effort).

The natural future deployment is **dredd composed with CaMeL** at session start, **DRIFT-style isolation** for context purification, Anthropic's probes (or the equivalent for non-Claude agents) at the model layer, and OS sandboxing as the blast-radius control — five independent layers addressing partially overlapping attack surfaces.

For paper-side reporting (P15 §2 / §4.4), the runtime-interception family above is the basis for the "complementary rather than dominant" framing the post-Test-17 tier-match revision calls for.

**Honest scope-boundary acknowledgement (P15 §4.6):** AgentLAB's attack-class taxonomy includes *memory poisoning* (manipulating the agent's persisted state across sessions) — out-of-scope for every member of the runtime-interception family above, dredd included. The judge / classifier / rule engine sees the tool-call-vs-task surface, not the agent's internal memory state. This is a clean honest "future work" rather than a defence failure to disclose.
