# Test requirement — P21: does whole-repo context let an agent make the SAST-residual allow/hold call?

**Date:** 2026-06-20
**Requested by:** P21 paper (`Cloud-Security/Adrian/p21/`) — spun out of the P20 arc; see `p21/DESIGN.md`, `p21/DESIGN_CRITIQUE.md`, `p21/AGENT_BRIEF.md`.
**Priority:** MEDIUM — gated on credentials (Bedrock/OpenAI), exactly as P20's pilots were. The **benchmark** (deck + κ + SAST tiers + separability) is built P21-side and is credential-independent; **this request covers only the model runs** that need creds.
**Harness:** **NET-NEW runner required** — `p21/run-repo-context-judge.ts` (to be written), reusing the backend/model-invoke layer, `sampling` metadata block, fail-soft census, and result envelope from `p20/run-adversarial-judge.ts` + `src/`. It is *not* a flag on the P20 runner: P21's judged unit is a **(repo snapshot, unified diff)** decided by a **tool-using agent over multiple turns**, not a single `toolCall` string. See §2.
**Output contract (reuse P20's, extended):** `cases[].reps[]` (each rep keeps `verdict ∈ {allow,hold}` **and** `confidence`) + `labels.json`, **plus** per-rep `condition`, `filesRead[]` (retrieval trace), `turns`, and token counts. P21's analysis scripts (`Cloud-Security/Adrian/p21/figures/`) consume this; `scripts/compute-wilson-ci.py` is reused unchanged.

---

## 1. Why

P20 established, on a *simpler* decision (tool-call hijack approval), that no LLM security judge has a deployable gate operating point: a **stable ~30–40% shared blind spot** survives every prompt and every panel, the failure is **bias not variance**, and consensus saturates at ~2 effective votes ($Q=0.59$). P21 asks an **orthogonal** question on a *harder* decision: for the **SAST-residual** — changes that compile, pass tests, AND pass Semgrep/CodeQL/Bandit, yet should be **held** because the verdict depends on facts in the *rest of the repo* — does giving an agent **whole-repository read access** let it make the `allow`/`hold` triage call that SAST cannot make at all, and does it beat a **context-blind diff-only LLM**?

The headline is the **value of repo context**, and it is purely an experimental-conditions question:

1. **Capability + lift (RQ1/RQ2).** Does the repo-context agent's per-category hold-recall beat (a) SAST (≈0 on the residual by construction) and (b) a context-blind LLM that sees only the diff? The Δ over the context-blind LLM is *the* number.
2. **Is the lift really *context*, or scaffold/compute (RQ2 confound)?** The agent differs from the blind LLM along several axes at once (sees repo content, runs a multi-turn loop, longer prompt, more tokens). A win could come from any of them. The **empty-scaffold** and **oracle-context** controls (§3, C4/C5) isolate content from scaffold and from retrieval competence.
3. **Dose-response (RQ3).** Does more context help monotonically or saturate/distract? The ablation ladder locates the sweet spot (and any reversal).
4. **Stability (RQ4, carried from P20).** The agent now follows a *non-deterministic tool-use trajectory* (which files it reads) — a new variance source on top of token sampling. Does P20's bias-not-variance / blind-spot finding recur here? **Pre-registered hypothesis H0: a shared residual survives repo context too.** Confirming or refuting it is a contribution, not a failure.

**Framing is triage/advisory, not an autonomous gate** (inherited from P20): we report the full hold-recall vs false-hold frontier; whether any condition reaches a gate-grade point is a finding, not a success criterion. The triage-usefulness bar is **pre-registered P21-side before any cell runs.**

---

## 2. Required harness changes (the bulk of the work — net-new runner)

A flag on the P20 runner will not do; P21 needs a tool-using agent over a repo. Build `p21/run-repo-context-judge.ts`:

1. **Deck loader for the P21 schema.** The deck is built P21-side (generalising `Cloud-Security/Adrian/p21/cases/`, whose `deck.json` is the canonical shape: `pairs[] { pairId, category, module, holdSymbol, allowSymbol, sastStatus, contextRule, sastEvasionNote, holdReason, groundTruth{hold,allow} }`). The loader must **materialise, per item, the concrete artifact the reviewer sees** — a **unified diff** of the change applied against a checked-out **repo snapshot** — plus the ground-truth `allow|hold`, `category`, `contextRule`, `sastStatus`, and the separability tier. One deck item = one matched-pair side (the hold variant and its allow twin are two items sharing a `pairId`).
2. **Read-only repo tool surface + bounded agent loop.** Give the agent `read_file`, `grep`/`ripgrep`, `list_dir` (and, behind a flag, `call_graph`/`imports` + a repo retrieval index). Multi-turn, **bounded turn/token budget**, **no write/exec**. Reuse `src/`'s backend abstraction for the underlying model calls so all P20 backends (`bedrock`/`openai`/`ollama`) work unchanged.
3. **Context conditions as a first-class CLI dimension** (`--condition`), the manipulated variable — **hold model, prompt, temperature FIXED across conditions** so only the context envelope varies:
   - `sast` — run pinned Semgrep + CodeQL + Bandit (see §2.5); no LLM. Lower bound.
   - `blind` — diff only, single-turn, no repo tools. Isolates value of context vs value of an LLM.
   - `touched` / `callgraph` / `retrieval` / `agentic` — the dose-response ladder: diff → +directly-touched files → +reverse call-graph/imports → +whole-repo retrieval → +free agentic exploration. **Fix the retrieval mechanism across the ladder; vary only the budget** so the ladder measures *amount* of context, not tooling.
   - `empty` — **scaffold-matched, context-empty control:** identical agent loop / prompt / turn budget / tools, but the tools return nothing useful (empty or decoy repo). If this scores like `blind`, the lift is genuinely context; if it scores well, the lift is the loop/prompt/compute. **Decisive for the headline claim.**
   - `oracle` — **oracle-context upper bound:** feed the agent the exact decisive evidence (the `CONVENTIONS.md`/`ARCHITECTURE.md`/allowlist lines, the prior architecture inventory) assembled deterministically, no agentic retrieval. The gap `oracle − agentic` = retrieval competence, reported as its own number.
4. **Per-rep logging extension.** Record `condition`, `filesRead[]` (the retrieval trace), `turns`, and `inputTokens/outputTokens/totalTokens` on every rep. The trace drives the **retrieval-coverage diagnostic** (did the agent actually read the file containing the decisive fact? a "never retrieved" miss is a different failure from a "read it and mis-ruled" miss) and the trajectory-variance analysis (RQ4).
5. **SAST baseline as a two-tier fairness contract** (may be a separate script, run once, not per-rep). Pin tool versions + ruleset SHAs and run **both** (i) community/default and (ii) security-audit/max (Semgrep `p/security-audit` + CodeQL `security-extended` + Bandit all-plugins). Record fire/no-fire per case under both tiers. **A case is a residual *subject* only if it evades the strong tier**; catchable cases are controls. (The deck is constructed to evade; this run *verifies* it on the cred-holder's pinned toolchain and produces the SAST row of the results.)

Reuse verbatim: the `sampling` metadata block (record `temperature`/`thinking`/`backend`/`effort`), the fail-soft "Judge error" census (drop, don't score), `build`/`gitSha` stamping, and `scripts/compute-wilson-ci.py`.

---

## 3. Cells

Hold the **base model fixed** so context is the only manipulated variable. Primary base = `eu.anthropic.claude-opus-4-8` (P20's strongest single, eu-central-1). Repeat the core arms on **one open-weight model** (`qwen.qwen3-235b-a22b-2507-v1:0`, eu-central-1 per `p15b/model-access-2026-06-06.md`) to check the finding isn't Anthropic-specific. Every LLM cell runs the **full deck** (risky residual + plain-benign + benign near-misses).

**Reps: N ≥ 5 per case per cell** for *every* condition (not just RQ4) — context-lift point estimates from a single agentic run are not credible given trajectory variance. N=5 is the floor; raise toward 10 if budget allows. (Lower than P20's 20 because per-decision cost is far higher: an agentic cell is many tool-call turns.)

| # | Arm | `--condition` | Purpose |
|---|---|---|---|
| C0 | SAST baseline | `sast` (both tiers) | lower bound; verifies the residual evades the *strong* tier |
| C1 | **context-blind LLM** | `blind` | isolates value of context vs value of an LLM — the lift denominator |
| C2 | **repo-context agent** | `agentic` | the proposed system; Δ(C2,C1) = **the headline lift** |
| C3a–d | dose-response ladder | `touched` / `callgraph` / `retrieval` (+`agentic`=C2) | RQ3 saturation/reversal, per category |
| C4 | **empty-scaffold control** | `empty` | is the lift context or scaffold/compute? (must ≈ C1) |
| C5 | **oracle-context** | `oracle` | upper bound; `C5−C2` = retrieval competence |
| B1–B3 | qwen repeat | `blind`/`agentic`/`oracle` on `qwen3-235b` | generalisation across base model |

**Minimum viable subset: C0, C1, C2, C4, C5 on Opus over the strong-tier-evading deck.** That alone gives the context lift (C2−C1), the scaffold-vs-content control (C4), and the retrieval-competence decomposition (C5−C2) — i.e. the headline plus its main confound. The ladder (C3) and qwen repeat (B*) are the next priority if creds/budget allow.

---

## 4. Run commands (sketch)

```bash
# C1 context-blind (diff only):
AWS_REGION=eu-central-1 npx tsx p21/run-repo-context-judge.ts \
  --judge-model eu.anthropic.claude-opus-4-8 --backend bedrock \
  --deck p21-residual --condition blind --reps 5 \
  --out-dir results/p21-residual-20260620/

# C2 repo-context agent:        --condition agentic   (bounded turn/token budget)
# C4 empty-scaffold control:    --condition empty
# C5 oracle-context:            --condition oracle
# C3 ladder:                    --condition touched|callgraph|retrieval
# C0 SAST (separate, once):     python p21/sast_baseline.py --tiers community,security-audit
# B*: --judge-model qwen.qwen3-235b-a22b-2507-v1:0
```

Keep N≥5, stamp `build`/`gitSha`, preserve the fail-soft marker (drop, don't score), populate `confidence`, `filesRead[]`, `turns`, and tokens on **every** rep. One dir per cell under `results/p21-residual-20260620/`, each with `cases[].reps[]` + the shared `labels.json`.

---

## 5. Success criteria (what P21 needs back)

Hand back the raw cells + `labels.json` + the C0 SAST manifest. P21's analysis then produces:

1. **Per-category hold-recall** (the four categories differ) and **false-hold** reported *separately* for plain-benign vs benign-near-miss (the availability cost). Read **MCC, not F1**, on the balanced risky deck.
2. **Context lift (headline):** Δ(hold-recall) and Δ(false-hold) of C2 over C1 (the diff-only LLM) and over C0 (SAST, ≈0). With Wilson CIs across trajectory+sampling variance — a point estimate is not enough.
3. **Content-not-scaffold check:** does **C4 (empty-scaffold) ≈ C1 (blind)**? If yes, the lift is genuinely repo content. If C4 scores well, the lift is the loop/prompt/compute and the thesis is unproven.
4. **Retrieval decomposition:** `C5 (oracle) − C2 (agentic)` = how much the agent loses to *not finding* the evidence vs *mis-reasoning* over it; cross-check against the per-rep `filesRead[]` coverage diagnostic.
5. **Dose-response curve** (C1→C3a→C3b→C3c→C2): monotone, or saturate/reverse? Locate the per-category optimum.
6. **Stability / H0:** run-to-run flip rate (trajectory vs sampling variance); whether a **stable shared blind spot survives repo context** (H0). Report whether fail-closed aggregation helps here or the P20 bias-not-variance finding recurs.
7. **Cost:** tool calls / turns / tokens / latency per decision, per condition — context isn't free; the agent must justify it. Include a **token/compute-matched** comparison so "agent won" isn't "agent spent 20× the tokens."
8. **Triage-bar verdict:** report the pre-registered triage-usefulness target against the measured frontier — met or missed is a *finding*, not a pass/fail.

A one-page `results/p21-residual-20260620/SUMMARY.md` with per-arm, per-category hold-recall / false-hold / Wilson CIs lets P21 drop the numbers straight in.

---

## 6. Notes

- **The deck is not yet at full scale.** `Cloud-Security/Adrian/p21/cases/` is a **7-pair feasibility prototype** proving constructibility; it must be generalised (per `p21/DESIGN.md §6` + `AGENT_BRIEF.md` Phase 2) — fictitious documented org spec, second-annotator **κ per category**, two-tier SAST verification, **diff-separability quarantine** + token counterbalancing, benign near-misses outnumbering risky — **before** any cell runs. **Do not run on the prototype and report it as results.**
- **The empty-scaffold (C4) and oracle (C5) controls are load-bearing** — they are what separate "context is the lever" from "the agentic harness is the lever." Re-state this to whoever runs the cells: without C4/C5 the headline RQ is asserted, not shown.
- **The retrieval trace (`filesRead[]`) is mandatory**, not optional telemetry — it is the only way to attribute a miss to retrieval vs reasoning.
- **κ, the SAST strong-tier residual, the separability quarantine, and the pre-registered bar are produced P21-side and are credential-independent** — they do not block on this request and should already be done by the time cells run.
- Reuse, don't fork, the P20 plumbing: backend abstraction, `sampling` block, fail-soft census, `compute-wilson-ci.py`. Only the agent loop + context conditions + deck loader are new.
- Record actual `temperature`/`thinking`/`condition`/`turnBudget` in result metadata. Note the Anthropic thinking-forces-T=1 caveat P20 documented.
