# Plan — Wire PromptArmor into the P15 Test-Framework

**Date:** 2026-05-13
**Author:** Claude Opus 4.7 (1M)
**Status:** Scoping. No code changes yet.
**Predecessor:** `docs/tests-needed-2026-05-13.md` (T-2 dependency)
**Purpose:** Make T-2 (T3e × PromptArmor across vendors) executable from `test-framework/`.

---

## TL;DR

**~6–10 hours of implementation work split across 4 tasks**, gated on one ~30-minute SDK probe. The server-side PromptArmor is fully built (`src/promptarmor-baseline.ts`, 370 lines, screening + sanitisation + telemetry); the gap is wiring it into the test-framework's agent loop. Architectural fit looks clean: the Claude Agent SDK's `PostToolUse` hook exposes `updatedMCPToolOutput` which is exactly the surface PromptArmor needs.

**One unresolved risk** (R-1 below): the SDK's hook return field is named `updatedMCPToolOutput`, suggesting MCP-tool-only. The test-framework uses built-in tools (`Read`/`Write`/`Bash`/`Glob`/`Grep`). A 30-minute probe before any other work is mandatory — outcome determines whether we have a 6-hour clean path or a 12-hour workaround.

---

## What already exists

| Component | Location | Lines | Status |
|---|---|---:|---|
| PromptArmor screener (Bedrock + OpenAI backends, sanitisation, telemetry) | `src/promptarmor-baseline.ts` | 370 | ✅ Done |
| PromptArmor system prompt (paper §3 reconstruction) | `src/promptarmor-prompts.ts` | 32 | ✅ Done |
| Unit tests | `src/test-promptarmor-baseline.ts` | 401 | ✅ Done |
| InjecAgent runner integration (Python) | `benchmarks/injecagent/promptarmor_defense.py` | — | ✅ In production |
| AgentDojo runner integration (Python) | `benchmarks/agentdojo/promptarmor_defense.py` | — | ✅ In production |
| Test-framework agent loop (TypeScript, Claude Agent SDK) | `test-framework/src/executor.ts` | 270 | ✅ Done; **no PromptArmor adapter** |
| Test-framework defence-selection in runner | `test-framework/src/runner.ts:67-112` | — | ✅ Supports `none`/`drift-only`/`anchor-only`/`intent-tracker`; **no `promptarmor` arm** |
| Test-framework SDK-hook integration (PreToolUse-based) | `test-framework/src/sdk-hooks.ts` | 248 | ✅ Done; **no `PostToolUse` rewrite path** |

The server-side screener is fully reusable. The implementation gap is *purely the integration*: spawn the screener, slot it into the SDK's hook chain on `PostToolUse`, route the sanitised result back into the conversation.

---

## Architectural fit

### Where PromptArmor goes in the loop

| Defence | Hook point | What it sees | What it can change |
|---|---|---|---|
| `intent-tracker` (existing) | `PreToolUse` | `tool_name` + `tool_input` | Allow/deny **the call** |
| **`promptarmor` (new)** | **`PostToolUse`** | `tool_name`, `tool_input`, `tool_response` | Rewrite **the response** before the agent reads it |

The two defences are at structurally different points in the loop. They're composable (could run both — see `docs/tests-needed-2026-05-13.md` T-5).

### SDK surface (verified against `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts`)

```typescript
type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;          // <-- screen this
  tool_use_id: string;
};

type PostToolUseHookSpecificOutput = {
  hookEventName: 'PostToolUse';
  additionalContext?: string;
  updatedMCPToolOutput?: unknown;  // <-- rewrite this
};
```

**The interventional surface exists.** Unverified question is whether `updatedMCPToolOutput` only applies to MCP-routed tools (likely, given the field name) or to all tools including built-ins.

---

## Tasks

### Task 0 — SDK rewrite-surface probe (30 min, **must precede everything else**)

Build a 50-line throwaway test that:
1. Spawns `query()` with a built-in tool (`Read` against a fixed file with known content).
2. Registers a `PostToolUse` hook that returns `{ hookSpecificOutput: { hookEventName: "PostToolUse", updatedMCPToolOutput: "REWRITTEN_BY_HOOK" } }`.
3. Forces the agent to a follow-up turn that reads back the tool output (e.g. "What did the file say?").
4. Asserts the agent's next-turn response contains `REWRITTEN_BY_HOOK`, not the file's actual contents.

**Outcome branches:**
- **Hook rewrites built-in tools too.** ✅ Path A: clean implementation, ~6h further work.
- **Hook only rewrites MCP tools.** ⚠️ Path B: manual session-history reconstruction needed; ~+4h. Alternative path C (observational PromptArmor — measure detection rate, not end-to-end ASR) is fallback if B is too invasive.

Don't proceed past T-0 without recording the branch in the plan.

---

### Task 1 — Adapter (~2h, Path A; +1h Path B)

New file: `test-framework/src/promptarmor-defence.ts`. ~150 LOC.

Responsibilities:
- Construct one `PromptArmorBaseline` instance per scenario run (so per-run `runId` telemetry lands in `test-framework/results/promptarmor/<runId>/calls.jsonl`).
- Expose a single async function `screenToolResult(toolName, toolInput, toolResponse) → { sanitised, verdict, latencyMs, sanitisationFailed }`.
- Handle the screener throwing (network failure) by returning verdict `clean` + the original content — fail-open semantics, log warning. **Matches `benchmarks/injecagent/promptarmor_defense.py` behaviour for parity with the existing PromptArmor cells.**
- Take a `taskContext` parameter (the original task) — passed through to the screener for telemetry, currently unused by PromptArmor's prompt (paper §3 doesn't condition on task context). Forward-compat hook.

**Import path:** the test-framework's `src/promptarmor-defence.ts` would need to import the server-side `src/promptarmor-baseline.ts`. Two options:
- **Option α** (recommended): use a relative import `../../src/promptarmor-baseline.js`. Requires the test-framework's `tsconfig.json` to allow it (currently `"rootDir": "./src"` — needs to be widened or removed).
- **Option β**: copy `promptarmor-baseline.ts` + `promptarmor-prompts.ts` + `bedrock-client.ts` + `openai-client.ts` into `test-framework/src/`. Cleaner test-framework boundary but introduces a second copy of the screener (drift risk).

**Recommend α** — single source of truth, tsconfig change is one line.

---

### Task 2 — Hook wiring (~2h, both paths)

Extend `test-framework/src/sdk-hooks.ts` with a new factory:

```typescript
// signature
export async function createPromptArmorHooks(
  config: { backend: "bedrock" | "openai"; model: string; runId: string },
): Promise<{ hooks: HooksConfig; screener: PromptArmorBaseline; stats: () => PromptArmorRunStats }>;
```

The new hook is `PostToolUse`, registered in parallel to (or instead of) the existing `intent-tracker` chain. It:
1. Extracts `tool_response` from the hook input.
2. Awaits `screener.screen(toolResponse, originalTask)`.
3. If `verdict === "injected"`, returns `{ hookSpecificOutput: { hookEventName: "PostToolUse", updatedMCPToolOutput: sanitised } }`.
4. If `verdict === "clean"` or `verdict === "parse_error"`, returns `{}` (pass through).
5. Tracks per-run stats (calls made, latency P50/P95, verdicts seen, sanitisation_failed count).

**Edge case:** `tool_response` may be a structured object (file_content + metadata) rather than a string. The current InjecAgent / AgentDojo Python adapters stringify before screening. Match that: `screen(JSON.stringify(toolResponse))` and parse the sanitised result back if structured. **Document the stringify in the new file.**

---

### Task 3 — Runner arm (~1h, both paths)

In `test-framework/src/runner.ts`, extend the `--defence` flag:

```typescript
// Add to runner.ts:67-112
case "promptarmor":
  // PromptArmor is content-side preprocessor, not a TurnLogger.
  // Return a no-op logger; the actual defence wires via createPromptArmorHooks()
  // which the executor must consume separately.
  // ... see executor changes in Task 4
```

New CLI flags:
- `--promptarmor-backend bedrock|openai` (default: `bedrock`)
- `--promptarmor-model <model_id>` (default: `eu.anthropic.claude-sonnet-4-6` for bedrock; `gpt-4o-2024-08-06` for openai)
- `--promptarmor-run-id <string>` (default: derived from defence + timestamp, same format as existing `outputPath`)

Also add the `promptarmor` defence to the help text on the `default:` branch's error message.

---

### Task 4 — Executor integration (~1.5h Path A; +3h Path B)

**Path A (PostToolUse hook works on built-in tools):**

In `test-framework/src/executor.ts`, after the `IntentTracker`-aware branch (line 65), add a parallel branch that, when `defence === "promptarmor"`, constructs `createPromptArmorHooks` and merges its `hooks` config into the `queryOptions` (lines 104-118). Then collect stats after each scenario, attach to `TestResult` for reporting.

Total change: ~30 LOC in executor.ts + small TestResult schema addition in types.ts.

**Path B (PostToolUse rewrites only MCP, NOT built-ins):**

Manual conversation reconstruction:
1. Don't pass `resumeSessionId` between turns; instead capture the full message stream from each turn.
2. After each turn, walk the message stream's `tool_result` events, screen each, and build a sanitised history.
3. For the next turn, instead of `prompt: userMessage` + `resumeSessionId`, send `prompt: <full sanitised history + new user message>`. (SDK supports `prompt: string` only currently — would need to format the history as a single user message, which is awkward.)
4. Alternative B' — fork the SDK to support `messages: Array<Message>` input. Out of scope for this revision.

Path B realistically forces a fallback to observational-only PromptArmor (record what *would* have been sanitised, don't actually intervene). The paper would need a footnote distinguishing T3e × PromptArmor's "detection rate" from InjecAgent's "end-to-end ASR" — acceptable if reviewers accept the caveat; not ideal.

---

### Task 5 — Smoke test + result-schema parity (~1h)

End-to-end smoke:
- Run `t3-goal-hijacking` (the one scenario file in `test-framework/scenarios/`) with `--defence promptarmor --repetitions 2`.
- Verify:
  - PromptArmor `calls.jsonl` is created with the expected shape (matches `src/promptarmor-baseline.ts:CallLogEntry`).
  - `TestResult` JSON output includes a `promptarmorStats` field (new; mirrors InjecAgent's `summary.json` shape so the paper's combined table is easy to assemble).
  - Sanitised tool outputs are visibly different from raw outputs on the injected-content turns (manual inspection of the JSONL).

**Pass criterion:** smoke run completes; per-call telemetry lands on disk; sanitisation visibly fires on at least one turn of the `t3-goal-hijacking` scenario.

---

### Task 6 — Documentation (~30min)

Update `test-framework/README.md` with:
- A `--defence promptarmor` section listing the new flags and an example invocation.
- A note that the screener is the same code path as the production hook's `promptarmor-baseline.ts` — single source of truth.
- A pointer to `benchmarks/injecagent/promptarmor_defense.py` as the closest analogue for cross-corpus parity.

---

## Risks

### R-1 — `updatedMCPToolOutput` may only rewrite MCP tools

Field name in `PostToolUseHookSpecificOutput` strongly suggests MCP-only. Test-framework uses built-in tools (`Read`, `Write`, `Bash`, `Glob`, `Grep`). **Mitigation: Task 0 probe.** If the probe confirms MCP-only:
- Path B (manual history) probably costs more than it's worth.
- **Recommended fallback:** observational-PromptArmor (record detection-rate only, not end-to-end ASR). Paper notes this as a methodological caveat — InjecAgent and AgentDojo do measure end-to-end; T3e in the test-framework only measures detection accuracy. Detection-rate parity is what PromptArmor's *own* paper reports anyway.

### R-2 — Per-turn screening latency disrupts the agent loop

InjecAgent telemetry shows PromptArmor adding ~1.5 s per call. T3e scenarios have ~3-5 tool calls per turn × multiple turns = ~5-10 PromptArmor calls per scenario. At 1.5 s/call, that's +10-15 s per scenario, which is dwarfed by SDK call latency (~30 s/turn). Acceptable.

### R-3 — Token cost on Sonnet detector

T3e at full plan-B scope is ~4,500 PromptArmor calls. At Sonnet 4.6 Bedrock pricing (~$3/M in, $15/M out) and observed ~200 in / 50 out tokens per call → ~$3 + ~$3 ≈ $6. Trivial.

### R-4 — Bedrock client's temperature default is 0.1, not 0

`promptarmor-baseline.ts:166-172` notes this: Bedrock client doesn't expose temperature override; defaults to 0.1. Paper's PromptArmor uses 0. **Mitigation:** logged in call log per-record; no implementation change in this scope. If reviewers raise it, add `temperature` override to `bedrock-client.ts` (~30 min, separate PR).

### R-5 — `parse_error` verdict behaviour

`promptarmor-baseline.ts:213-224` treats `parse_error` as "leave content unchanged, log warning" — fail-open. **Verify** the InjecAgent / AgentDojo Python adapters do the same; mismatch would invalidate cross-corpus comparability. (Spot-check during Task 1.)

---

## Time and cost summary

| Task | Path A | Path B (mitigated) | Path C (observational) |
|---|---:|---:|---:|
| T-0 SDK probe | 0.5 h | 0.5 h | 0.5 h |
| T-1 Adapter | 2 h | 3 h | 1.5 h |
| T-2 Hook wiring | 2 h | — | 1 h (observe-only hook) |
| T-3 Runner arm | 1 h | 1 h | 1 h |
| T-4 Executor integration | 1.5 h | 4.5 h | 1.5 h |
| T-5 Smoke test | 1 h | 1 h | 1 h |
| T-6 Docs | 0.5 h | 0.5 h | 0.5 h |
| **Total** | **8.5 h** | **10.5 h** | **7 h** |
| **API spend (smoke + T-2 full run)** | ~$8 | ~$8 | ~$6 |

Path A is the target. Path C is the contingency if T-0 reveals the hook can't rewrite built-in tools.

This **fits inside the Plan B1 "~1 day" budget** as long as T-0 lands on Path A.

---

## Open questions for the user before starting

1. **Path A vs Path C if R-1 is unfavourable.** Path B (manual history reconstruction) is probably not worth the cost — the harness becomes brittle. If T-0 shows the hook is MCP-only, do we accept the methodological caveat of Path C (observational-only on T3e × PromptArmor)?
2. **Option α vs β for the import path.** Single source via relative import (cross-package coupling) vs duplicate the screener under `test-framework/src/`. Default plan above assumes α.
3. **Branch to commit on.** Continue `intent-history-active`, or cut a new `promptarmor-test-framework` branch? Current branch already has 3 in-flight context shifts (handlers split, user-perms, tests-needed doc edits).

---

## Definition of done

1. `npm run test:promptarmor -- --scenario all --repetitions 1` from `test-framework/` completes without error.
2. `test-framework/results/promptarmor/<runId>/calls.jsonl` exists and parses; verdict distribution non-trivial.
3. `test-framework/results/results-promptarmor-*.json` has the same top-level shape as `results-intent-tracker-*.json` plus the new `promptarmorStats` field.
4. Smoke verification on the `t3-goal-hijacking` scenario: at least one injected-content turn is screened and either rewritten (Path A) or recorded (Path C).
5. Spec parity check: per-call latency P50, verdict distribution, and sanitisation_failed-rate from one T3e run match within ±20% of the equivalent InjecAgent cell's values (validates the screener is behaving consistently across corpus drivers).

After all five are green, run T-2 from the gap-analysis doc proper: T3e.2–T3e.4 × {Sonnet 4.6, Opus 4.7, Qwen3-32B, Qwen3-235B, GPT-4o-mini} × PromptArmor arm, N=60 per scenario per cell.

---

## Reproducibility note for the paper

When this lands, update the paper §sec:limitations / methods to mention:
- The PromptArmor screener used in T3e is the **same source file** as in InjecAgent (`src/promptarmor-baseline.ts`) — corpus-driver-independent.
- The hook point on T3e is `PostToolUse` (test-framework SDK) vs Python-side tool-response interception (InjecAgent/AgentDojo). Functionally equivalent; document the structural symmetry.
- (Path C only) the T3e × PromptArmor cell reports detection-rate, not end-to-end ASR; cite paper's own protocol parity (PromptArmor §4.1 reports detection-rate metrics).
