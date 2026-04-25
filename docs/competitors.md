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
| Running Claude in production, want zero extra deployment cost | **Anthropic's representation probes** (on by default) — but stack JudgeAIDredd on top for the residual gap (Opus 4.7 + safeguards still 25% Shade ASR per system card) |
| Coarse-grained but battle-tested isolation against unknown agent behaviour | **OS sandboxing** (gVisor, Firecracker, Nitro Enclaves) plus any of the above |
| Pre-existing CLI workflow with permission prompts | Harden the existing CLI (allowlists, dredd as auto-approval on `consistent`, escalate `drifting`/`hijacked` to the human) |
| Defence-in-depth across multiple layers | CaMeL session-start restriction + dredd PreToolUse approval + OS sandbox + vendor-internal probes |
| Conversation-layer guardrails (chat moderation) | NeMo Guardrails, LLM Guard, Lakera Guard |
| Static analysis on agent-generated code | LlamaFirewall's CodeShield, GitHub Advanced Security, Semgrep |

---

## Honest positioning summary

Dredd's contribution is **not** "the only defence against prompt injection" — that would be overclaiming. It is the **runtime, context-isolated, per-tool-call approver** position in a layered defence stack. The most informative comparators on AgentDojo's exfiltration metric are CaMeL (capability restriction, dominates on precision) and `tool_filter` (the simplest baseline, weak on both axes). LlamaFirewall is architecturally adjacent but not directly comparable on AgentDojo because it reports against Meta's CyberSecEval-style harness; IsolateGPT runs on a multi-app isolation framework. The natural future deployment is **dredd composed with CaMeL** at session start and Anthropic's probes (or the equivalent for non-Claude agents) at the model layer — three independent layers addressing partially overlapping attack surfaces.

For paper-side reporting (P15 §4.4), the table above is the basis for the "complementary rather than dominant" framing the post-Test-17 tier-match revision calls for.
