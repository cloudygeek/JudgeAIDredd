# Prompt-injection defence landscape vs Dredd

**Date:** 2026-05-23
**Source:** Paper Lantern (`explore_approaches` over 108 papers, `deep_dive` over 79 papers — see citations at end).
**Question:** What ways exist to defend tool-using LLM agents from prompt-injection / goal hijacking, how do they compare to what Dredd does today, and is a graph-based stage worth adding?

---

## TL;DR

Dredd today implements **Family 1** (rule-based runtime guardrails) plus a custom
embedding-cosine drift detector plus an LLM judge. The graph / plan-based family
(Family 3) reports **0–3% attack success** with **~1–3% false-positive rate** at
**~0.5–1s extra latency**, and it's the family whose properties most directly
complement what Dredd is missing today: a per-session declared *plan* that any
tool call has to map to, rather than per-call drift judgment.

**Recommendation: prototype it as a new Stage 0.7 between user-deny and policy**
— before Stage 1 policy and Stage 3 judge, after Stage 0 user-deny. Cache the
plan in DynamoDB (same store), fall back to today's pipeline when there's no
matching plan node, and treat low-risk read-only tools as "node expansion"
(allowed without a plan entry).

---

## The five defence families (with arXiv citations)

Paper Lantern grouped 108 recent papers into 5 high-level families. For each
I've added a one-line gap analysis against today's Dredd:

### Family 1 — Rule-based runtime guardrails

> ClawGuard, Progent, MiniScope, DRIFT.

A middleware sits between the LLM and any external tool. Sanitises arguments,
checks against a whitelist/blacklist, asks the user for ambiguous cases.

Reported impact: **ClawGuard 100% DSR on AgentDojo, 50–84% ASR reduction on
SkillInject**; Progent **39.9% → 1.0% ASR on AgentDojo**; MiniScope **4× fewer
user confirmations at 1–6% latency**; DRIFT **30.7% → 1.3% ASR on AgentDojo**.

**Dredd today**: Most aligned with this family. `tool-policy.ts` is exactly
this (`ALLOWED_TOOLS`, `ALLOWED_BASH_PATTERNS`, `DENIED_BASH_PATTERNS`,
`REVIEW_BASH_PATTERNS`, `checkDangerousCombination()`). Coverage is comparable.
The friction-counter / interactive-mode `ask` is the user-confirmation arm.

Cited: [1, 2, 3, 4].

### Family 2 — Causal attribution / counterfactual checks

> AttriGuard, AgentSentry.

Before a tool call runs, the system replays the same context with the
suspicious observation masked, and only allows the call if the masked replay
*also* produces the same call. If the call only appears when the suspicious
observation is present, it's flagged as observation-driven (i.e. injected).

Reported impact: **AttriGuard 0% ASR on static attacks at ~3% utility loss**;
**AgentSentry 0% ASR across all evaluated families, +20.8–33.6 pp utility under attack**.

**Dredd today**: Nothing in this space. Embedding cosine + LLM judge both look
at the *call*, not at the *causal chain*. The hardest indirect-injection cases
— where attacker payload hides in retrieved file/web content — are exactly what
this family is designed for. Cost: extra inference call per intercepted tool
call (likely ~1.5 s on Bedrock Sonnet), pushing close to the 3 s budget.

Cited: [5, 6].

### Family 3 — Plan-based execution isolation (graph / DAG)

> IPIGuard, PlanGuard, AgentArmor.

Generate an execution plan up front (only from the user's request, before any
tool fires). Store as a DAG. At runtime, each tool call has to match a
pre-approved node. Unknown calls go to a secondary verifier or get blocked.

Reported impact: **PlanGuard 0% ASR on InjecAgent at 1.49% FPR**;
**IPIGuard 0.69% ASR / 58.77% utility**;
**AgentArmor 3% ASR on AgentDojo, 0% on ASB, ~1% functional overhead**.

**Dredd today**: Nothing in this space. The closest is the *intent* stack +
embedding-similarity-to-intent, but that's a single semantic anchor, not a
structured plan. The judge re-evaluates per call rather than per-plan-node.
This is the family the user flagged as worth exploring; **deep-dive details below**.

Cited: [7, 8, 9].

### Family 4 — Argument-level provenance contracts

> PACT.

Every tool argument is tagged with its source (user-provided, output of trusted
tool, untrusted external content). A contract checks that each parameter's
provenance satisfies the role-specific trust level required.

Reported impact: **PACT 100% security on the strongest models, 38–46% utility
recovery, +8–16 pp over CaMeL**.

**Dredd today**: Nothing in this space. Tool wrappers in Claude Code are
opaque to Dredd — Dredd sees only the call, not where each argument came from.
Implementing this would require either wrapping Claude Code's tool layer or
adding provenance tags to a parallel argument-tracking path.

Cited: [10].

### Family 5 — Dynamic policy generation + privilege separation

> Progent-LLM, MiniScope ILP, OpenClaw, Authenticated Prompts.

A policy-generation LLM converts the user's request into a JSON policy
(allowed tools, domains, file paths) at session start. Some designs split the
agent into a *reader* (sees raw input only) and an *actor* (privileged to call
tools), signing prompts between the two so injection can't cross the boundary.

Reported impact: **Progent-LLM 39.9% → 1.0% ASR on AgentDojo**;
**OpenClaw 0% ASR on LLMail-Inject**.

**Dredd today**: Partial. The "managed allow-list" (Phase 7) auto-splices
conservative allow patterns into `settings.local.json`. The Phase 8b approval
pattern-trust does its own per-session learning. But there's no per-session
*policy* derived from the user's request — Dredd reads the user's existing
allow/deny lists rather than generating them.

Cited: [2, 3, 11].

---

## Where Dredd is strong vs the literature

- **Latency** — Dredd Stage 1 policy runs in <10 ms; the embedding stage adds
  ~50 ms (Ollama) or ~400 ms (Bedrock Cohere). Most papers report ≥500 ms
  per call. Dredd's stack-of-cheap-checks-before-the-LLM design is
  competitive with the best published.
- **Operational** — Dredd has interactive mode (Claude Code surfaces "ask"
  prompts) + per-session mode + admin override + audit log + dashboard + API
  keys. Papers tend to ship a research prototype, not a production system.
- **Multi-turn / pivot support** — Dredd's intent-stack (Phase 7+) handles
  user mid-session pivots, queued prompts, sub-tasks, replacements,
  revisits. Most graph-based papers were single-turn benchmarks; they
  don't model the conversation flow Dredd already does.

## Where Dredd lacks coverage

- **Indirect-injection via file/web content**: Dredd's drift detector
  measures similarity between the *tool call* and *intent*. It doesn't measure
  whether the suspicious tool call was *caused by* a recent observation
  (i.e. an injected file the agent just read). Family 2 (causal attribution)
  is the dedicated counter.
- **Structured plan enforcement**: Dredd never asks "what was the user's
  declared plan? does this call fit it?" — every call is judged on its
  own merits against a free-text intent string. Family 3 (graph) is the
  dedicated counter.
- **Per-argument trust levels**: Dredd has a single "session origin" — every
  argument is treated the same regardless of where it originated. Family 4
  (provenance contracts) is the dedicated counter.

---

## Deep-dive: would a graph-based stage work in Dredd?

Paper Lantern's `deep_dive` returns verdict **PROTOTYPE** (= worth a small
investment to test). Key findings:

### Where to insert it in the pipeline

After Stage 0 (user-deny), before Stage 1 (policy). Call it **Stage 0.7**.
- Skip when no plan has been generated for the session yet (fall back to
  the rest of the pipeline unchanged).
- On a plan match: short-circuit allow with `stage=plan-allow` and no further
  evaluation.
- On a plan miss: fall through to Stage 1 normally — don't deny outright
  because mid-session pivots are normal in interactive mode.

### Plan generation

- Triggered on **/intent** at session start (or first message of a new
  intent-stack entry). Runs once per logical task, not per turn.
- Calls the same Bedrock Sonnet judge model with a planning-mode prompt
  (`temperature=0`, output the JSON DAG).
- Output: `{id, tool_name, args (where known), depends_on[]}` per node.
- Cost: ~1 extra Bedrock call per task pivot, ~2× token use of a normal turn
  (the planner sees only the user prompt; output is small structured JSON).

### Storage

- New DynamoDB row type in `jaid-sessions`: `pk=SESSION#<id>`,
  `sk=PLAN#<created_at>#<plan_id>`. Existing TTL applies.
- Includes a `replan_allowed: true` flag.
- On user pivot (intent-stack `replacement` / `revisit` / `new-task`), mark
  the prior plan complete and generate a new one.

### Matching policy

Quoting IPIGuard / PlanGuard transfer notes verbatim:

> **temperature = 0 [CRITICAL]** — keep deterministic so the plan doesn't
> drift between turns.

> **hard_match_threshold = exact string match [CRITICAL_IN_SOURCE_CONTEXT]**
> — exact match is safe but causes higher false positives; relax to fuzzy
> matching (Levenshtein ≤ 2 on argument strings) if you observe >2%
> legitimate re-plans being blocked.

Two-stage match:
1. Hard rule: exact `tool_name` match + intersect static args. If pass: allow.
2. Soft rule: if hard fails but the call is structurally close (same tool,
   different args), re-use Dredd's existing judge with a *plan-context*
   prompt: "the user plan expects {expected_tool} with {expected_args}; the
   agent wants {actual_tool} with {actual_args}; benign variation or
   injection?"

### Node expansion (the dynamic-arg escape hatch)

For tools whose arguments are unknowable at planning time (e.g. a `Read` whose
file path depends on a prior `Glob`), the plan node carries `args = null`.
Only read-only tools (Read, Glob, Grep, WebSearch...) are allowed to fill in
later. Write/exec tools (`Bash`, `Write`, `Edit`) must have args declared.

### Failure modes flagged by the literature

| Mode | Symptom | Fix |
|---|---|---|
| Over-strict matching | Legit user pivots blocked, FPR >5% | Relax to fuzzy match OR enable node expansion for more tools |
| Latency blow-up | p95 > 3 s | Cache plan in DynamoDB; cap intent-verifier max_tokens to 64 |
| Missing dynamic args | Tool errors with "missing parameter" | Node expansion on read-only tools, or pre-populate placeholders |
| Graph desync | Out-of-order execution slips through | Enforce topological traversal: reject any call whose `depends_on` deps aren't marked complete |

### Estimated cost / impact on Dredd

| Metric | Today | With graph stage |
|---|---|---|
| p95 latency per /evaluate | ~2.0 s (Bedrock judge dominant) | ~2.5 s (plan lookup ~50 ms, soft-match judge same as today) |
| Cost per active session | 1× planner call once + N judge calls | 1.5× (extra planner call, but judge frequency may drop because hard-match path skips judge) |
| Attack-success rate (estimated) | n/a in head-to-head | Expected drop based on literature (IPIGuard 0.69%, PlanGuard 0%, AgentArmor 3%) |
| False-positive rate | n/a | ~1.5–3% on benign tasks (literature) |

---

## Family 1 vs Family 3 head-to-head (Paper Lantern compare_approaches, 166 papers)

Done. Headline: **they're complementary, not competing.** The recommended
production pattern is "rule layer first, graph verifier second only when the
rule layer is uncertain."

### Strengths and weaknesses

| | Family 1 (rule-based) | Family 3 (plan/graph-based) |
|---|---|---|
| **Latency** | Sub-millisecond (Progent: 0.0008 s per call) | +20% (Policy Compiler) to +70% (AgentArmor — 69.6% of runtime spent constructing graph) |
| **Token cost** | Zero extra (operates on already-generated call) | ~2× — separate planning LLM call up front |
| **ASR** | 0–1.3% (Progent 0%; DRIFT 30.7% → 1.3% on GPT-4o-mini) | 0–3% (PlanGuard 0%; IPIGuard 0.69%; AgentArmor 3%) |
| **FPR** | Up to **38%** with hard rules alone, drops dramatically when paired with a semantic verifier | **1.49%** with two-stage verifier (PlanGuard) |
| **Causal-flow modelling** | None — sees only the call | Full dependency graph; catches indirect injection that hides in retrieved content |

### The critical insight for Dredd

PlanGuard reports **38% FPR with hard rules alone, dropping to 1.49% after
adding a semantic verifier.** Dredd already *has* that semantic verifier — the
LLM judge with the hardened B7.1 prompt. So the FPR-reduction story for the
graph stage is conditional on something Dredd already operates. We're in a
good starting position.

### Combination pattern (recommended by the literature)

```
PreToolUse call
   │
   ├─ Stage 0   user-deny           (existing — Bearer-API-key)
   │
   ├─ Stage 0.5 pattern-trust       (existing — Phase 8b approvals)
   │
   ├─ Stage 0.7 plan-allow          (NEW: hard-match vs the DAG)
   │     │
   │     └─ if hard-match miss: pass-through to Stage 1+ unchanged
   │
   ├─ Stage 1   policy              (existing — rule-based, fast filter)
   │
   ├─ Stage 2   embedding-drift     (existing)
   │
   └─ Stage 3   judge               (existing, NOW also seeded with the
                                    plan DAG as context — "the plan said
                                    {expected}; the call is {actual}; is
                                    this benign variation or injection?")
```

The graph DAG **isn't a replacement for any existing stage**. It's an
additive short-circuit for tool calls that exactly match a planned node
(skipping all later stages including the judge — a meaningful cost win
on hot-path tool calls), plus a new piece of context fed to the judge
when there's a partial match. The literature says serialising the graph
as JSON in the judge's user prompt is the canonical pattern (PlanGuard,
IPIGuard).

### Conflicts to watch for

The compare-step calls out only one real conflict: **both stages must not
rewrite tool arguments.** Today Dredd doesn't rewrite (it returns
allow/deny/ask). The graph stage shouldn't either — confirm during
prototyping. If a future iteration adds arg-rewriting, the rule stage runs
first and either blocks or passes the call unchanged to the graph stage.

### What the comparison did NOT change

The deep-dive's verdict (PROTOTYPE) stands. Specifically:
- Insert as Stage 0.7 (confirmed by the layered diagram above).
- Behind `DREDD_PLAN_ENFORCEMENT_ENABLED` env flag, default false.
- Plan generation once per task pivot, NOT per turn.
- Storage as `PLAN#...` rows in `jaid-sessions`.
- Node expansion for read-only tools.
- Replan on intent-stack pivot.

## Recommended next steps

1. ~~Run `compare_approaches` on Family 1 + Family 3~~ — done above.
2. **Run `check_feasibility` against Dredd's actual constraints** — Paper
   Lantern's verdict was `PROTOTYPE`, but the constraints I gave it were the
   summarised spec, not the full implementation. A constrained re-check might
   land at `GO` (or `RECONSIDER`).
3. **Skeleton implementation in a branch** —
   - `src/plan-store.ts` (DynamoDB CRUD)
   - `src/plan-generator.ts` (Bedrock call producing the DAG)
   - new Stage 0.7 in `pretool-interceptor.ts`
   - `DREDD_PLAN_ENFORCEMENT_ENABLED` env flag, default false (same Phase
     6/7/8 rollout pattern)
4. **Benchmark on AgentDojo and InjecAgent** — both papers used those, so
   we get an apples-to-apples ASR/FPR comparison.

---

## Citations

Paper Lantern verified the following arXiv references (primary-source verified).

**Family 1 — Rule-based:**
- [1] Zhao et al. (2026). *ClawGuard: A Runtime Security Framework for Tool-Augmented LLM Agents Against Indirect Prompt Injection*. [arXiv:2604.11790](https://arxiv.org/abs/2604.11790).
- [2] Shi et al. (2025). *Progent: Programmable Privilege Control for LLM Agents*. [arXiv:2504.11703](https://arxiv.org/abs/2504.11703).
- [3] Zhu et al. (2025). *MiniScope: A Least Privilege Framework for Authorizing Tool Calling Agents*. [arXiv:2512.11147](https://arxiv.org/abs/2512.11147).
- [4] Li et al. (2025). *DRIFT: Dynamic Rule-Based Defense with Injection Isolation for Securing LLM Agents*. [arXiv:2506.12104](https://arxiv.org/abs/2506.12104).

**Family 2 — Causal attribution:**
- [5] He et al. (2026). *AttriGuard: Defeating Indirect Prompt Injection in LLM Agents via Causal Attribution of Tool Invocations*. [arXiv:2603.10749](https://arxiv.org/abs/2603.10749).
- [6] Zhang et al. (2026). *AgentSentry: Mitigating Indirect Prompt Injection in LLM Agents via Temporal Causal Diagnostics and Context Purification*. [arXiv:2602.22724](https://arxiv.org/abs/2602.22724).

**Family 3 — Plan-based execution isolation (the graph option):**
- [7] Gong and Deng (2026). *PlanGuard: Defending Agents against Indirect Prompt Injection via Planning-based Consistency Verification*. [arXiv:2604.10134](https://arxiv.org/abs/2604.10134).
- [8] An et al. (2025). *IPIGuard: A Novel Tool Dependency Graph-Based Defense Against Indirect Prompt Injection in LLM Agents*. [arXiv:2508.15310](https://arxiv.org/abs/2508.15310).
- [9] Wang et al. (2025). *AgentArmor: Enforcing Program Analysis on Agent Runtime Trace to Defend Against Prompt Injection*. [arXiv:2508.01249](https://arxiv.org/abs/2508.01249).
- [12] Rosario et al. (2025). *Architecting Resilient LLM Agents: A Guide to Secure Plan-then-Execute Implementations*. [arXiv:2509.08646](https://arxiv.org/abs/2509.08646).

**Family 4 — Argument-level provenance:**
- [10] Fan et al. (2026). *The Granularity Mismatch in Agent Security: Argument-Level Provenance Solves Enforcement and Isolates the LLM Reasoning Bottleneck*. [arXiv:2605.11039](https://arxiv.org/abs/2605.11039).

**Family 5 — Dynamic policy / privilege separation:**
- [11] Cheng and Tsao (2026). *Agent Privilege Separation in OpenClaw: A Structural Defense Against Prompt Injection*. [arXiv:2603.13424](https://arxiv.org/abs/2603.13424).
