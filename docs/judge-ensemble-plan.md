# Judge LLM Ensemble — Plan

Status: planning. Scope: judge LLMs only. Embedding stays single-model for now.

## Goal

For each `/evaluate` call, fan out to N judge configurations in parallel and aggregate the verdicts. Make it easy to A/B test models (including local Ollama models) and prompt variants under live traffic, with full per-member audit trails for offline analysis.

## Decisions (from review with Adrian, 2026-05-02)

| Q | Answer |
|---|---|
| Default when `JUDGE_CONFIGS` is unset | Single-member ensemble using current `--judge-model` / `--prompt` / `--judge-effort`. Backwards compatible. |
| Aggregation default | `strict` — any member returning `hijacked` denies. More blocking is acceptable; FPR will be measured against P14 + AgentDojo legitimate suite afterwards. |
| Per-member reasoning size | Uncapped — full `reasoning` and pre-parse `rawResponse` in the session log for offline analysis. |
| Run in `learn` mode? | Yes — ensemble runs in shadow too. Doubles cost, but A/B data is the point. |

## Config surface

```
--judge-configs "eu.anthropic.claude-sonnet-4-6:B7.1:high,nemotron-3-super:B7,llama3.2:standard"
JUDGE_CONFIGS="..."
--judge-aggregate strict|majority|unanimous-allow   # default: strict
--judge-timeout-ms 15000                             # global wall-clock per /evaluate
```

Single-model flags (`--judge-model`, `--prompt`, `--judge-effort`) still work — interpreted as a one-member ensemble. If `JUDGE_CONFIGS` is set, it overrides the singletons.

Member format: `model:prompt:effort`, with `:effort` optional. `prompt` accepts `standard|B7|B7.1|B7.1-office`. Backend (`ollama` vs `bedrock`) auto-selected by model id via existing `isBedrockModel`.

## Aggregation

| Mode | Rule | Notes |
|---|---|---|
| `strict` (default) | Any `hijacked` → deny. | Most pessimistic. Default while we collect FPR data. |
| `majority` | ≥ ⌈N/2⌉ vote `hijacked` → deny. | Balanced; activate after FPR measurement. |
| `unanimous-allow` | Deny unless every member is `consistent`. | Hardest setting; reserved for high-trust environments. |

`error` and `timeout` member outcomes never count as `hijacked` under any mode (fail-soft, matches current single-judge behaviour). If every member fails, fall back to allow + log loudly.

## Architecture

| Component | Change |
|---|---|
| `src/judge-config.ts` (new) | Parse `JUDGE_CONFIGS` string → `JudgeMemberConfig[]`. |
| `src/intent-judge.ts` | No change — already a single-config class; one `IntentJudge` instance per member. |
| `src/judge-ensemble.ts` (new) | Fans out via `Promise.allSettled` with `--judge-timeout-ms`. Returns `{ verdict, confidence, reasoning, members }`. |
| `src/pretool-interceptor.ts` | Calls ensemble. `judgeMembers: JudgeMemberResult[]` added to `InterceptionResult`. |
| `src/server.ts` | `_meta.judgeMembers` on `/evaluate` response. Per-tool-call `judgeMembers` in session-end log. |
| `fargate/docker-entrypoint-judge.sh` | Surface `JUDGE_CONFIGS`, `JUDGE_AGGREGATE`, `JUDGE_TIMEOUT_MS`. |

## Per-member result schema

```ts
interface JudgeMemberResult {
  model: string;
  prompt: "standard" | "B7" | "B7.1" | "B7.1-office";
  effort?: "low" | "medium" | "high" | "max";
  backend: "ollama" | "bedrock";
  verdict: "consistent" | "drifting" | "hijacked" | "error" | "timeout";
  confidence: number | null;
  reasoning: string;            // full, uncapped — offline analysis fodder
  rawResponse?: string;         // pre-parse JSON for partial-JSON debugging
  thinking?: string;            // backend-supported chain-of-thought
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  errorMessage?: string;
}
```

Logged uncapped. Session log structure:

```
interceptorLog[i].judgeMembers: JudgeMemberResult[]
interceptorLog[i].judgeAggregation: "strict" | "majority" | "unanimous-allow"
interceptorLog[i].judgeRolledUp: { verdict, confidence, reasoning }   // = current top-level
```

## Failure handling

- `Promise.allSettled` with global timeout (`--judge-timeout-ms`, default 15 s).
- Member past deadline → `verdict: "timeout"`. Member throws → `verdict: "error"` with `errorMessage`.
- Errors/timeouts never trigger deny under any aggregation.
- All-fail → fall through to current fail-soft path (`drifting`, log warning).

## Cost / latency notes

- Wall-clock ≈ slowest finishing member. Sonnet 4.6 ~1.4 s, Nemotron / Qwen3 ~10–15 s on Ollama.
- Spend roughly multiplies by member count for paid backends. Local Ollama members are free but slower — pair them with a fast Bedrock anchor for latency.
- For A/B: run ensemble in `learn` mode to gather verdicts without enforcement, then switch to `autonomous` once a config wins.

## Phased delivery

1. `judge-config.ts` parser + unit tests for the comma/colon string format.
2. `judge-ensemble.ts` — strict-only first; aggregation flag wired but only `strict` accepted.
3. Wire into `pretool-interceptor.ts` + `server.ts`. Add per-member to `_meta` + session log.
4. `learn`-mode ensemble pass-through + dashboard hooks.
5. Add `majority` and `unanimous-allow` aggregations.
6. Validation: replay P14 + T22 + T29 single vs. ensemble; FPR on AgentDojo legitimate suite. Iterate.

## Out of scope (for now)

- Embedding ensemble. Single-model `DriftDetector` continues. Revisit after judge ensemble is validated.
- Cross-member confidence calibration. Use raw verdicts; calibrate later from collected data.
- Adaptive member selection (drop slow/unreliable members at runtime). Keep static for v1.

## Open backcompat hooks

- `--judge-model` / `--prompt` / `--judge-effort` keep working unchanged.
- `JudgeVerdict` shape on `_meta.judgeVerdict` stays — it now carries the rolled-up result. Members appear alongside in `_meta.judgeMembers`.
