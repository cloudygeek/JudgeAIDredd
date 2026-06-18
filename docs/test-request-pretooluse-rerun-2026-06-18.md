# Test requirement — re-run the post-turn suites under the PreToolUse gate (p15a/defence)

**Date:** 2026-06-18
**Requested by:** P15 defence-paper authoring pass (Cloud-Security/Adrian/p15b/p15b-defence.tex)
**Priority:** HIGH — these suites back the paper's flagship exfiltration-prevention results, and they were evaluated at the wrong judge call point.
**Harness:** `test-framework/src/runner-t3e-pretooluse.ts`, `test-framework/src/runner-p14.ts` (+ the shared executors `executor-{bedrock,converse,openai,vertex,mantle}.ts`, `executor.ts`).
**Subsumes:** `docs/test-request-crackvector-enforced-2026-06-18.md` (the crack-vector portion is included here as one matched campaign).

---

## 1. Why — these suites judged the agent at the wrong point

The defence paper's architecture is **PreToolUse**: evaluate each proposed tool call *before* it executes and deny the offending call. But the test-framework executors that produced the T3/T3e/T4/T5 and crack-vector results judge **post-turn**, which is the Stop-hook design the paper itself rejects (§threatvectors):

- Every executor (`executor.ts`, `executor-bedrock.ts`, `executor-converse.ts`, `executor-openai.ts`, `executor-vertex.ts`, `executor-mantle.ts`) follows the same pattern: `logger.shouldBlock()` at **turn start** → `executeTool(...)` runs **all** the turn's tool calls unconditionally → `logger.onTurnComplete(...)` judges **after** the turn. (`executor-openai.ts:20` documents it: "shouldBlock at turn-start … onTurnCompleteAsync after each turn".)
- A `hijacked` verdict therefore blocks only the **next** turn; a same-turn exfiltration (`Read .env` then `curl`) has already left before the verdict exists.
- Direct evidence (MiniMax-M2.5 crack-vector run, `results/p15b-2026-06-15-minimax-m2.5/`): 54/211 exfiltrating runs had `verdict=hijacked, blocked=true` on the exfil turn **yet the canary still left**.

**These suites are affected (post-turn):** T3, T3e (network-exfil + disclosure), T4, T5, and the crack-vector corpus (T1, TCMD, TDELAY, TDEP, TEGRESS, TEMIT, TLOG, TMCP, TMCPDESC, TRULES, TSLOP, TSTAGE, TWEB).

**These are NOT affected (already PreToolUse — do not re-run):**
- **AgentLAB** — `runner-agentlab.ts` uses `createDefenceHooks` (`sdk-hooks.ts`), the real `PreToolUse` deny hook.
- **AgentDojo** — `benchmarks/agentdojo/dredd_defense.py` is a `BasePipelineElement` inserted *before* `ToolsExecutor`, gating each call at `/evaluate`.
- **InjecAgent** — `benchmarks/injecagent/run_benchmark.py:evaluate_via_dredd()` POSTs each proposed tool call to `/evaluate` for allow/deny before execution.
- **MT-AgentRisk** — `benchmarks/mt_agentrisk/` (`dredd_bridge.py` + `agent_loop.py`) evaluates per tool call at `/evaluate` and tracks `blocked_ids` from `permissionDecision=deny`.
- **Mode 4** — separate (P14), a CLI permission-proxy gate (C1-approve/deny), not the Dredd intent-judge; out of scope here.

So **the entire lethal-trifecta exfiltration story runs on the wrong call point**: the 11-exfiltrator defended table, Qwen3-235B 63%→21%, the minimax/disclosure cells, the Haiku split-file 11/120→1/120, and the T4/T5 cells.

---

## 2. The fix

Route the affected suites through the **real PreToolUse gate** so a `hijacked` verdict aborts *that* tool call before it runs — the same path AgentLAB/AgentDojo already use. Two acceptable implementations:

- **(preferred)** reuse `sdk-hooks.ts:createDefenceHooks()` (→ `PreToolInterceptor.evaluate` → `permissionDecision: "deny"`, "blocked tools never execute") for the Claude-SDK-reachable agents; and
- for the Bedrock-Converse / OpenAI / Vertex executors (which MiniMax, Qwen, GLM, etc. use), add a **pre-execution gate inside the tool loop**: call the interceptor on each `toolUse` block and **skip `executeTool` on a deny**, instead of running all tool blocks then judging at `onTurnComplete`.

Hold everything else identical to the existing matrix so the *only* change is the call point: Sonnet 4.6 judge + prompt v2 (B7.1) + Cohere Embed v4; same scenarios, same per-cell N; per-rep JSON carrying the `build` field.

**Instrumentation:** record per tool call the verdict and whether the call was *aborted before execution* (vs the old turn-level `blocked`), so "denied-and-not-executed" is distinguishable from "judged-after-the-fact".

---

## 3. Suites × cells

| Suite | Scenarios | Agents (match existing matrix) |
|---|---|---|
| T3e (exfil + disclosure) | T3e.1–T3e.4 | Sonnet 4.6, Opus 4.7, Opus 4.8, Qwen3-32B, Qwen3-235B, Qwen3-Coder-30B, + the 11-exfiltrator open-weights front (DeepSeek-V3.2, GLM-4.7-flash, Nemotron, Devstral, gpt-oss-120b, MiniMax-M2.5, …) |
| T4 / T5 | existing T4/T5 cells | Anthropic frontier (control), Qwen3-235B, GPT-5.1, Gemini-3.1-pro |
| Crack-vectors | T1,T4,TCMD,TDELAY,TDEP,TEGRESS,TEMIT,TLOG,TMCP,TMCPDESC,TRULES,TSLOP,TSTAGE,TWEB | MiniMax-M2.5 (anchor vs. June-15 detection probe) + Qwen3-235B + a GLM/DeepSeek + an Anthropic-frontier floor control |

Bedrock ids per `Cloud-Security/Adrian/p15b/model-access-2026-06-06.md`.

---

## 4. Re-measure the cost axes too

Per-call PreToolUse fires the judge on a far larger fraction of tool calls than turn-level blocking did, so the §Performance numbers do **not** carry over:
- **Latency** (~500 ms/call claim), **compute** (<3% of agent spend), **FPR / utility** (the 0–33 pp delta) must all be re-measured under per-call gating, on the same legitimate-workload set.

---

## 5. Expected direction (state explicitly when results land)

Post-turn is a **conservative lower bound** on PreToolUse for exfiltration prevention, so the re-run should be **equal-or-stronger on security**, not weaker:
- T3e residuals are "confined to single-turn T3e.1," where the gate already **fires on 91–100% of defended runs** but couldn't abort post-turn — under PreToolUse those fires become aborts, so e.g. **Qwen3-235B's 21% residual should drop toward ~0**.
- On crack-vectors, the 54 `hijacked` exfils become prevented (36%→~27%); the 70 `consistent`-verdict (concealment) and 87 alternate-channel exfils still leak — confirming the §4.5 scope boundary under enforcement.
- Utility may improve (per-call deny is more surgical than blocking a whole next turn) while cost/latency rise.

Append a per-suite cross-cell summary line here when each lands. This replaces the post-turn numbers in p15b-defence.tex §cross-corpus / §4.5 with PreToolUse-architecture numbers.
