# Implementation Plan — PromptArmor Head-to-Head (Phases A1–A4)

**Date:** 2026-05-08
**Parent plan:** [docs/test-plan-promptarmor-headtohead-2026-05-08.md](test-plan-promptarmor-headtohead-2026-05-08.md)
**Why this exists:** the parent plan was written assuming the research scaffolding was on `main`, but it was removed after tag `research-v1`. This plan adds the restoration step, fixes paths the parent plan got wrong, and breaks A1–A4 into ordered, verifiable steps.

**Pick this up in a fresh Claude Code session.** The session that wrote this plan got its local Dredd intent stuck on a bundle-delivery check from many turns back, so every off-topic command tripped a hijack verdict. A new session re-registers intent and the v0.1.297 stack code (just deployed) handles append-vs-replace correctly going forward.

---

## Pre-flight (fresh session)

State at the moment of writing (commit `c975f1e7`):
- Hook + dashboard containers deployed at v0.1.297 (intent-stack feature live).
- Local hook script at `~/.claude/dredd/dredd-hook.sh` is the v0.1.297 build (now POSTs `/stop` on every Stop hook).
- Research scaffolding (`archive/`, `benchmarks/agentdojo/`, `benchmarks/mt_agentrisk/`, `scenarios/`, `fargate/tests/`, `src/policy-review.ts`, `src/types.ts`) is **not** on `main`. Lives under tag `research-v1`. ~100 files, ~22k lines.

First action of the new session: register the actual intent so Dredd's judge has a current goal.

> "Implement Phases A1–A4 of the PromptArmor head-to-head test plan: restore the research scaffolding from tag `research-v1`, vendor the PromptArmor prompt, build the `PromptArmorBaseline` class, wire it into the corpus runners, and write the smoke test. Plan: docs/plan-promptarmor-implementation-2026-05-08.md."

That sentence is substantive enough to be the original intent (won't be classified as a confirmation). Subsequent "yes" replies during the work will adopt the prior assistant proposal correctly under the new stack code.

---

## Step 1 — Restore the research scaffolding from `research-v1`

```bash
git checkout research-v1 -- archive/ benchmarks/ datasets/ fargate/tests/ scenarios/ src/policy-review.ts src/types.ts
git status --short | head -20
```

Expected: ~100 files staged-for-add. No edits to existing `main` files. Nothing in `src/` other than `policy-review.ts` and `types.ts`.

**Commit on its own** before any PromptArmor code lands — keeps the restoration cleanly reversible.

```bash
git commit -m "chore: restore research scaffolding from research-v1 for PromptArmor work"
```

**Important paths (after restoration), so the rest of the plan reads right:**

| Asset | Actual path on `research-v1` | Parent plan said |
|---|---|---|
| OpenAI executor | `archive/tests/executor-openai.ts` | `executor-openai.ts` |
| Bedrock executor | `archive/tests/executor-bedrock.ts` | `executor-bedrock.ts` |
| T3e runner | `archive/tests/runner-t3e-pretooluse.ts` | `src/runner-t3e-pretooluse.ts` |
| AgentLAB runner | `archive/tests/runner-agentlab.ts` | `src/runner-agentlab.ts` |
| Cross-vendor runner | `archive/tests/runner-stop-cross-vendor.ts` | `src/runner-stop-cross-vendor.ts` |
| AgentDojo runner | `benchmarks/agentdojo/run_benchmark.py` | `benchmarks/agentdojo/run.ts` |
| MT-AgentRisk runner | `benchmarks/mt_agentrisk/run_benchmark.py` | `benchmarks/mt_agentrisk/...` |

Note: AgentDojo + MT-AgentRisk runners are **Python**, not TypeScript. The parent plan implied TypeScript. Phase A3 needs different shapes for the two languages (TS-side `import`, Python-side subprocess or HTTP shim — see Step 4).

The `PromptArmorBaseline` class itself stays in `src/promptarmor-baseline.ts` per the parent plan — it's permanent code, not research scaffolding.

---

## Step 2 — A1: Source the PromptArmor prompt

Two passes:

**2a. Web search for the canonical release.**
- arXiv 2507.15219 → check abstract page, OpenReview, GitHub link if any.
- Search GitHub for `promptarmor` + `Shi` + ICLR 2026.
- If found: vendor verbatim into `src/promptarmor/prompts.ts`. Record upstream commit SHA in a header comment.

**2b. If no canonical source found, reconstruct.**
- Read §3 of the paper plus any prompts shown in figures / appendix.
- Write the reconstruction to `src/promptarmor/prompts.ts` AND document provenance in `docs/promptarmor-prompt-reconstruction-2026-05-08.md` — section by section, citing which figure/paragraph each fragment came from.
- Open a tracker question in the doc: should we email authors before the paper goes out?

Either way, the file structure is:

```
src/promptarmor/
  prompts.ts          # the canonical or reconstructed prompt text
```

Single export: `export const PROMPTARMOR_SYSTEM_PROMPT: string`. No logic in this file.

---

## Step 3 — A2: `PromptArmorBaseline` class

**File:** `src/promptarmor-baseline.ts`

**Surface (from parent plan):**
```ts
export class PromptArmorBaseline {
  constructor(private opts: {
    backend: "openai" | "bedrock";
    model: string;
    promptVersion: "canonical" | "reconstructed";
  });
  async screen(content: string, taskContext?: string): Promise<PromptArmorResult>;
}

export interface PromptArmorResult {
  verdict: "clean" | "injected";
  sanitised: string;          // = content if verdict=clean; sentinel string if injected
  latencyMs: number;
  tokens: { in: number; out: number };
}
```

**Wiring:**
- OpenAI backend → use restored `archive/tests/executor-openai.ts`. Reuse its connection pool and auth pattern; do NOT introduce a new client.
- Bedrock backend → use restored `archive/tests/executor-bedrock.ts`. Same rule.
- Default `temperature: 0`. Record the actual temperature on each call.
- Per-invocation telemetry → append a JSONL line to `results/promptarmor/<run-id>/calls.jsonl` with `{prompt_tokens, completion_tokens, latency_ms, backend, model, temperature, verdict, content_hash}`. `content_hash` so we can join calls back to specific corpus items without re-storing the full blob.

**Verdict parsing:**
- Output format from PromptArmor's prompt is structured (read the paper's §3 for the exact form — usually a JSON or a single-token verdict). Implement a strict parser; on parse failure default to `clean` and log a warning. Do NOT fail-closed and silently strip benign content.

**Sentinel behaviour on `injected`:**
Match the paper: replace the offending content with a sentinel string — propose `[REDACTED-PROMPTARMOR-INJECTION-DETECTED]`. The agent can read it; downstream tools can grep for it.

---

## Step 4 — A3: Wire into the corpus runners

**Hook point in every runner:** wrap the existing tool-result-injection step. Each `tool_result_text` that flows back to the agent goes through `screen()` first. If `injected`, replace the text with the sentinel and record the verdict on the session JSON.

### 4a. TypeScript runners (T3e, AgentLAB, cross-vendor)

Direct `import { PromptArmorBaseline } from "../../src/promptarmor-baseline.js"`. Construct one per process at startup, reuse for every screen. Per-runner edits:

| File | What to add |
|---|---|
| `archive/tests/runner-t3e-pretooluse.ts` | Wrap the existing PreToolUse result-injection step. Pass the upcoming user-task text as `taskContext`. |
| `archive/tests/runner-agentlab.ts` | Same shape. |
| `archive/tests/runner-stop-cross-vendor.ts` | Same. Used for backend-symmetry runs. |

Add a `--with-promptarmor=<backend>:<model>` CLI flag to each runner so we can run with-and-without on the same corpus.

### 4b. Python runners (AgentDojo, MT-AgentRisk)

Two options, in order of preference:

**Option A (recommended): HTTP shim.** Add a `POST /screen` endpoint to `src/server-hook.ts` that wraps `PromptArmorBaseline.screen()`. Python runners call it via `requests.post`. Keeps the PromptArmor logic in one place. ~30 lines on each side.

**Option B: subprocess.** Python runner shells out to a small `node` script that imports `PromptArmorBaseline` and prints JSON. Worse: 50ms cold-start per call × 15k AgentDojo calls = 12 minutes of overhead. Skip.

Pick A. Endpoint shape:
```
POST /screen
{
  "content": "...",
  "task_context": "...",
  "backend": "openai" | "bedrock",
  "model": "gpt-4o" | ...
}
→ { "verdict", "sanitised", "latency_ms", "tokens": { "in", "out" } }
```

Auth: same Bearer-key gate as the other hook endpoints. Add a `screen` permission (or just reuse the existing API-key gate — these are research runs, not production traffic).

---

## Step 5 — A4: Smoke test

**File:** `src/test-promptarmor-baseline.ts`

Two assertions per the parent plan:
1. **Verdict precision.** 10 known-injected blobs from T3e + 10 known-benign blobs. Assert `injected` precision >50% on the injected set (sanity-check, not the actual experiment). Pull the blobs from `scenarios/t3-goal-hijacking.ts` (now restored).
2. **Latency budget.** p95 latency <2 s with `gpt-4o`. Paper claims 200–600 ms; allow headroom.

Skip OpenAI calls if `OPENAI_API_KEY` not set; skip Bedrock if no AWS creds. Test passes vacuously when one backend is unavailable, with a clear `skipped:` log.

Run before kicking off Phase B.

---

## Step 6 — Commit boundaries

```
chore: restore research scaffolding from research-v1     ← Step 1
feat(promptarmor): vendor canonical prompt               ← Step 2
feat(promptarmor): PromptArmorBaseline class             ← Step 3
feat(promptarmor): wire into TS corpus runners           ← Step 4a
feat(promptarmor): /screen endpoint for Python runners   ← Step 4b
test(promptarmor): smoke + latency assertions            ← Step 5
```

Six commits. Each individually compiles, type-checks, and passes the smoke test (where applicable). Do not collapse into one — restoration is huge and noisy and reviewers want to see PromptArmor code separately from a 22k-line file restore.

After Step 5 lands, sandbox redeploy is required for Step 4b (the new `/screen` endpoint). Steps 1–4a + 5 only need a local repo.

---

## Risks specific to this implementation pass

| Risk | Mitigation |
|---|---|
| `archive/tests/executor-*.ts` won't compile against current dependencies | Run `npx tsc --noEmit` after Step 1. Fix breakages individually. If a referenced lib was removed from package.json, restore it (or stub the call). |
| PromptArmor prompt is genuinely closed-source | Reconstruct + email authors **before** Phase B kicks off (we don't want to publish a head-to-head against a misreconstructed defence). |
| `/screen` endpoint becomes a public injection-vector if exposed | It's auth-gated like all hook endpoints. ALB is internal only. No additional exposure. |
| Restored code uses old session-tracker API surface | Likely. The session-tracker has changed substantially (intent stack, owner stamping, Dynamo-backed). Either: (a) update the restored code to the new API (preferred) or (b) restored runners use direct API key auth and don't touch SessionStore. Audit at Step 1's tsc pass. |
| Restored fargate test entrypoints reference deleted infra | Fine — we're not running them, just keeping the references for posterity. Don't spend time fixing fargate/tests/ unless something blocks. |

---

## What this plan does NOT do

- **Phase B (the 31.5k API call run).** Out of scope for code-side. Once A1–A4 ship, the parent plan's Phase B is "kick off the runners" — that's an operational task, not a code change.
- **Phase C (paper hand-off).** Lives in the Cloud-Security paper repo. This repo only emits the `results/promptarmor/<run-id>/{calls,disagreements,summary}.json{l}` artefacts; the paper repo consumes them.
- **Stack-feature follow-up testing** (`harness/test-confirm-fix.sh`, harness pair re-run). Decoupled from PromptArmor; do separately.

---

## Open question for the new session

The parent plan was authored from a worktree that included the research scaffolding (executors at `executor-bedrock.ts` not `archive/tests/executor-bedrock.ts`). I've corrected the paths in this implementation plan to match where the files **actually are** post-restoration. If you want them moved to `src/` instead — that's the third option from the prior conversation, and is a separate sweep of import-path edits. Recommendation: **don't move them**. The current `main` keeps `src/` lean; `archive/` is exactly where research-only code belongs. The PromptArmor class itself goes in `src/` because it's permanent product code.
