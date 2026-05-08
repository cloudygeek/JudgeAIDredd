# Test Plan — PromptArmor Head-to-Head

**Date:** 2026-05-08
**Context:** P15 was desk-rejected at IEEE Access on novelty grounds. The Cloud-Security paper repo's `Adrian/p15/PLAN_springer_revision.md` (commit `19f4a3c`) repositions for Springer *Cybersecurity* and identifies **PromptArmor** (Shi et al., ICLR 2026; arXiv 2507.15219) as the strongest competing defence — they report **<1% FPR and <1% FNR on AgentDojo**, which is the same benchmark we lead the paper with. This is the code-side plan for Stage B of that revision: implement PromptArmor as a baseline in our framework and run it head-to-head against intent-tracker prompts v1 (B7) and v2 (B7.1) across the same four corpora P15 already uses.

The headline output is a `tab:promptarmor-headtohead` row group adjacent to `tab:judge-leaderboard` plus a disagreement-cases table. Numbers go into the v2 manuscript draft.

**Authorised budget:** $200 in API spend. **Wall-clock:** 3–5 days. **Decision rule:** if the in-framework PromptArmor numbers reproduce the paper's <1% claim, that's itself the headline finding to report (we are not seeking to dispute it — we want a fair comparison and a disagreement analysis). If they don't reproduce, that's a separate (and arguably stronger) finding for §6.X.

---

## What PromptArmor is, in one paragraph

PromptArmor is a **preprocessor**: an off-the-shelf LLM call that scans every untrusted-content blob (tool result, retrieved document, web fetch) before that content enters the agent's context, and either flags it or returns a sanitised version. It does not run at PreToolUse and does not see the agent's proposed tool call. This is architecturally distinct from our intent-tracker / tool-based-approval judge, which fires at PreToolUse on the agent's proposed action with the trajectory but **without** the offending content. The two defences therefore cover different attack surfaces and a like-for-like comparison is well-posed.

---

## Phase A — Implement the PromptArmor baseline

### A1. Source the PromptArmor prompt

**Prereq.** Check arXiv 2507.15219 for an open-source release URL (the OpenReview page or the paper's GitHub link). If released:
- Vendor the canonical prompt verbatim into `src/promptarmor/prompts.ts`. Record the upstream commit SHA.

If **not** released:
- Reconstruct from §3 of the paper plus any prompts shown in figures / appendix.
- Record the reconstruction in `docs/promptarmor-prompt-reconstruction-2026-05-08.md` with full provenance for each section of the prompt (which figure / paragraph it came from).
- Open a question in the doc about whether to email the authors for the canonical prompt before running.

### A2. Add `PromptArmorBaseline` class

**New file:** `src/promptarmor-baseline.ts`. Sibling to `intent-judge.ts` and `pretool-interceptor.ts`. Public surface:

```ts
export class PromptArmorBaseline {
  constructor(private opts: {
    backend: "openai" | "bedrock";
    model: string;          // gpt-4o, gpt-4.1, o4-mini, claude-sonnet-4-6, claude-opus-4-7
    promptVersion: "canonical" | "reconstructed";
  });

  // Runs PromptArmor's preprocessing pass on a single untrusted-content blob.
  // Returns: { verdict: "clean" | "injected", sanitised: string, latencyMs: number, tokens: {in: number, out: number} }
  async screen(content: string, taskContext?: string): Promise<PromptArmorResult>;
}
```

Wire choices:
- **Backend reuse.** For OpenAI models go via the existing `executor-openai.ts` connection pool. For Anthropic models go via `executor-bedrock.ts`. Do not introduce a new client.
- **Cost / latency capture.** Record per-invocation `{prompt_tokens, completion_tokens, latency_ms, backend, model}` to a JSONL file at `results/promptarmor/<run-id>/calls.jsonl`. This is the data underlying the cost/latency columns in the head-to-head table.
- **Determinism.** Default `temperature: 0`. Record actual temperature in the JSONL.

### A3. Wire PromptArmor into the corpus runners

PromptArmor screens **content blobs**, not actions. Five corpora-runners need a hook to pipe each tool result through `PromptArmorBaseline.screen()` before it reaches the agent:

| Runner | File | Hook point |
|---|---|---|
| T3e (paper's own) | `src/runner-t3e-pretooluse.ts` | Wrap the existing pre-tool result-injection step. |
| AgentDojo | `benchmarks/agentdojo/run.ts` (verify path) | Each `*_text_result` returning from a tool call. |
| MT-AgentRisk | `benchmarks/mt_agentrisk/...` | Same: tool-result string returned to the agent. |
| AgentLAB | runner not yet split out — use `src/runner-agentlab.ts` | Same. |
| (cross-vendor) | `src/runner-stop-cross-vendor.ts` | Used for backend symmetry runs only; same hook. |

**Behaviour when PromptArmor returns `injected`:** match the paper's spec — strip the offending content (replace with a sentinel string the agent can read) **and** record the verdict in the session JSON. Do not block the tool call; PromptArmor is a content-side defence not an action-side one.

### A4. Integration test

`src/test-promptarmor-baseline.ts`:
- Smoke test: 10 known-injected blobs from T3e + 10 known-benign blobs. Assert PromptArmor returns `injected` on the first set with >50% precision (sanity, not the experiment).
- Latency budget assertion: p95 latency <2 s with `gpt-4o` backend (paper claims 200–600 ms; allow headroom).

Run before kicking off Phase B.

---

## Phase B — Run the head-to-head

### B1. Backends in scope (5)

Match P15's existing judge-leaderboard model set so the head-to-head table can sit next to `tab:judge-leaderboard` without a separate axis:

- `gpt-4o` (PromptArmor's strongest reported backend)
- `gpt-4.1`
- `o4-mini`
- `claude-sonnet-4-6`
- `claude-opus-4-7`

### B2. Corpora and run sizes

| Corpus | Invocations / backend | Total (5 backends) | Why |
|---|---:|---:|---|
| **T3e** | ~600 | 3,000 | Paper's primary; head-to-head must cover it. |
| **AgentDojo** | ~3,000 | 15,000 | PromptArmor's reported <1% FPR/FNR is on this benchmark. Reproduction-or-dispute is the centrepiece. |
| **MT-AgentRisk** | ~1,500 | 7,500 | Already in the paper; complete the matrix. |
| **AgentLAB** | ~1,200 | 6,000 | Lowest priority; **drops first** if budget binds (per parent plan §4 mitigation). |
| **Total** | — | **~31,500** | |

Cost estimate at current pricing (verify before each run):
- OpenAI (gpt-4o + gpt-4.1 + o4-mini, ~19k calls): ~$80–120
- Bedrock (Sonnet 4.6 + Opus 4.7, ~12.5k calls): ~$25–60
- **Estimated total: $105–180. Budget cap: $200.**

### B3. Run cadence

Sequential by corpus, parallel within (backend axis is independent). Use the existing parallel orchestration pattern from `run-test1-local-parallel.sh`:

```
day-1: T3e all 5 backends            (~3k calls,  ~$8–15)
day-2: AgentDojo all 5 backends     (~15k calls, ~$50–80)
day-3: MT-AgentRisk all 5 backends  (~7.5k calls, ~$25–40)
day-4: AgentLAB all 5 backends      (~6k calls,  ~$22–45)
day-5: head-to-head table + disagreement analysis
```

If Day-2 burn rate threatens the cap, halt before AgentLAB (Day-4) and report on three corpora.

### B4. Comparator definition (the "head-to-head" axis)

For each corpus × backend cell, run **three** defences:
1. **PromptArmor** (this plan, content preprocessor)
2. **Intent-tracker prompt v1 / B7** (existing, action-side judge at PreToolUse)
3. **Intent-tracker prompt v2 / B7.1** (existing, hardened action-side judge)

Existing P15 numbers cover (2) and (3) for the same backends and corpora (modulo any reruns the paper plan flags). The new spend is for (1) only — Phase B above is sized for that.

### B5. Metrics recorded per cell

Mandatory:
- ASR (attack success rate; lower is better)
- FPR (false positive rate on benign content)
- FNR (false negative rate; missed injections)
- Utility delta on benign tasks (PromptArmor will sometimes strip benign instructions)
- p50 and p95 latency per defence invocation
- Token cost per defence invocation
- Aggregate $ per task, per corpus

Persisted to `results/promptarmor/<run-id>/summary.json` per cell, plus a corpus-level `summary.json`.

### B6. Disagreement analysis (the editorially interesting part)

For each cell, dump cases where PromptArmor and the v2 judge disagree: PromptArmor=clean & judge=block, or PromptArmor=injected & judge=allow. Sample 30–50 disagreements stratified by (corpus, backend, disagreement-direction). For each:
- Categorise the failure: ambiguous content / multi-stage attack / benign instruction misread / injected-but-not-actionable / etc.
- Record verbatim content + both verdicts + reasoning traces.

Output: `results/promptarmor/<run-id>/disagreements.jsonl` and a derived 4–6-row qualitative table for the manuscript at `docs/promptarmor-disagreement-cases.md`.

---

## Phase C — Hand-off to the paper

Once Phase B completes:
- Push the head-to-head and disagreement summaries here in the dredd repo (results JSON + disagreement notes doc).
- The Cloud-Security paper repo's `springer-revision` branch will pull the numbers into `tab:promptarmor-headtohead` and the §6.5 narrative paragraph. Manuscript-side work tracked in `Cloud-Security/Adrian/p15/PLAN_springer_revision.md` Stage C.

No code in this repo is paper-specific; PromptArmor is a permanent baseline and stays in `src/`.

---

## Risks (code-side only)

| Risk | Mitigation |
|---|---|
| PromptArmor prompt not open-sourced | Reconstruct from paper §3; document provenance per A1; email authors before publication if reconstruction confidence is low. |
| AgentDojo invocation count exceeds estimate | Drop AgentLAB (Day 4) per budget rule. |
| OpenAI rate-limits on gpt-4.1 / o4-mini at 3k req/h | Stagger the parallel orchestration; spread Day 2 across two calendar days if needed. |
| Anthropic Bedrock region-quota limits on Opus 4.7 | Already hit before during T3e runs; use the existing fallback region list in `executor-bedrock.ts`. |
| Disagreement set is small (<20 cases) | Lower the categorisation N to whatever exists; report N transparently. |

---

## Decision points

None outstanding — budget, scope, and corpora set are locked per the parent plan. Code-side work can begin once branch state is confirmed clean (no in-flight modifications to `executor-bedrock.ts` or `runner-*.ts` from other in-progress work).
