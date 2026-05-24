# G1 — gpt-4o-mini + gpt-4o cross-vendor test requirements

Date: 2026-05-24
Reviewer: R2.1 — "Replicating even a subset of configurations — T1, T3, T4,
and T8 across C1, C3, and C4 equivalents — on GPT-4o or a capable open-weight
model would substantially strengthen this claim."
Source gap: `docs/p14-reviewer-gaps-2026-05-22.md` §G1.

This file specifies the P14 cross-vendor cells still needed on OpenAI models
to satisfy R2.1, the C-configuration mapping rule for non-Anthropic vendors,
the code prerequisites (the test22 runner does not yet route through OpenAI),
and the container env payloads. Qwen3-235B cells already landed in
`benchmarks/test22/runs/G1-qwen-*` (commit `b446535f4`); this doc covers
the OpenAI side.

## Acceptance test

A Table 8'-equivalent with rows `{T1, T3, T4, T8}` × columns
`{C1', C3', C4'}` for **two** non-Anthropic models — completing the
`{Qwen3-235B, GPT-4o-mini, GPT-4o}` triple alongside the existing Anthropic
matrix (Haiku-4.5 / Sonnet-4.6 / Opus-4.7). Per cell:

- ≥ 30 reps per (technique-variant, configuration) combination
- ASR, GES, hijack rate, exfiltration rate, stealth rate
- Single-run primary estimate; variance question is G2/G3, not here

Pass condition: the cross-vendor numbers either substantiate the
"system-prompt-dominates" finding (i.e. C1' >> C3' >> C4' on each model)
or qualify it explicitly (e.g. "GPT-4o-mini does not honour
system-prompt safety instructions to the same degree as Claude").

## Models

Both routed through OpenAI direct (api.openai.com chat-completions). Bedrock
does not host OpenAI models. Key file:
`/Users/adrian/IdeaProjects/JudgeAIDredd/openapi.key` (165 bytes,
single-line, gitignored, untracked — verified 2026-05-24). Both models
confirmed accessible by that key:

| Friendly name  | Concrete model ID         | Role                                 |
|----------------|---------------------------|--------------------------------------|
| `gpt-4o-mini`  | `gpt-4o-mini-2024-07-18`  | Smaller/cheaper; matches prior runs  |
| `gpt-4o`       | `gpt-4o-2024-08-06`       | Capable GPT-4-class per reviewer ask |

The model aliases are already wired in `archive/tests/executor-openai.ts:43-46`
`MODEL_MAP`, so the runner sees them as friendly names.

**Use both.** `gpt-4o-mini` alone is borderline against the reviewer's
"capable GPT-4-class" criterion; gpt-4o full closes that loop. The two
models also bracket the capability axis on the OpenAI side, mirroring
Haiku → Sonnet → Opus on the Anthropic side.

## Cross-vendor C-configuration mapping

R2.1 names C1 / C3 / C4 from the paper's Anthropic-specific configuration
table. C1 = Claude Code CLI default; C3 = SDK without system prompt; C4 =
SDK with no guardrails. These do not exist outside Claude Code, so we
define vendor-neutral analogues and reuse the prime-suffix to distinguish
them:

| Symbol | Anthropic (paper) | Non-Anthropic generalisation                            |
|--------|-------------------|---------------------------------------------------------|
| C1'    | CLI default       | vendor-default safety system prompt + sandbox + approval|
| C3'    | SDK no-sysprompt  | raw API, no system prompt, no approval                  |
| C4'    | SDK bypass        | raw API, no guardrails, no sandbox                      |

Concrete operationalisation in the test22 runner:

- **C1'**: identical CLI system prompt (`runner-p14.ts:C1_SYSTEM_PROMPT`)
  passed via `systemPrompt` on the OpenAI executor, container sandbox at
  workspace level (already enforced by the executor's `mkdtempSync`),
  approval flag on (judge-active arm).
- **C3'**: no `systemPrompt`, no approval. Mirrors C3 exactly: the only
  change is the API surface (OpenAI chat-completions vs Anthropic
  Messages).
- **C4'**: no `systemPrompt`, no approval, no sandbox limit. (For OpenAI
  this is the same as C3' since the executor sandbox is structural —
  there is no separate "bypass-permissions" mode to compare to in
  chat-completions. Document this as a known C3'≡C4' degeneracy in the
  resubmission text — the comparison still holds for Anthropic where C3 ≠ C4.)

The qwen3-235B G1 cells already in `benchmarks/test22/runs/G1-qwen-*`
were run as C4-baseline / C4-judge only — this doc requires extending
that to all three primes (C1', C3', C4') for both OpenAI models so the
factorial decomposition can be re-stated cross-vendor.

## Code prerequisites

Three changes are needed before the test22 P14 runner can drive
gpt-4o-mini / gpt-4o through the cross-vendor cells. None of them exist
in the runner today.

### P1. Add openai backend to `archive/tests/runner-p14.ts`

Current state (`runner-p14.ts:33-38`):

```typescript
const loadExecutor = async (backend: string) => {
  if (backend === "converse") {
    return (await import("./executor-converse.js")).executeScenario;
  }
  return (await import("./executor-bedrock.js")).executeScenario;
};
```

Required:

```typescript
const loadExecutor = async (backend: string) => {
  if (backend === "converse") {
    return (await import("./executor-converse.js")).executeScenario;
  }
  if (backend === "openai") {
    return (await import("./executor-openai.js")).executeScenario;
  }
  return (await import("./executor-bedrock.js")).executeScenario;
};
```

And extend the `AGENT_BACKEND` type union (`runner-p14.ts:87`) to include
`"openai"`.

### P2. Auto-route gpt-* model keys to the openai backend

The entrypoint script today reads `TEST22_AGENT_BACKEND` (default
`converse`). For mixed-vendor sweeps, default per-model:

`fargate/tests/docker-entrypoint-test22.sh`, around the `AGENT_BACKEND`
assignment:

```bash
# Auto-route OpenAI models when not explicitly set
if [[ -z "${TEST22_AGENT_BACKEND:-}" ]]; then
  if [[ "${MODELS}" == gpt-* || "${MODELS}" == *,gpt-* ]]; then
    AGENT_BACKEND="openai"
  else
    AGENT_BACKEND="converse"
  fi
else
  AGENT_BACKEND="${TEST22_AGENT_BACKEND}"
fi
```

For mixed-CSV cases (e.g. `claude-sonnet-4-6,gpt-4o-mini` in one cell),
the simpler answer is: **don't mix vendors in one cell**. Run OpenAI
models on their own containers. The entrypoint should error out if
`gpt-*` is mixed with non-`gpt-*` in `TEST22_MODELS`.

### P3. Propagate OPENAI_API_KEY through the entrypoint

`fargate/tests/docker-entrypoint-test22.sh` does not currently reference
`OPENAI_API_KEY`. Add a guard before invoking the runner:

```bash
if [[ "${AGENT_BACKEND}" == "openai" && -z "${OPENAI_API_KEY:-}" ]]; then
  echo "FATAL: AGENT_BACKEND=openai but OPENAI_API_KEY is unset" >&2
  exit 1
fi
```

The OpenAI executor at `executor-openai.ts:340-342` already throws if the
key is missing, but failing early in the entrypoint surfaces the problem
before container time is spent on AWS auth etc.

**Effort estimate:** ~30 min for all three changes, plus image rebuild
(~10 min CodeBuild). No image-extend is required — the OpenAI executor
imports only built-ins + the existing `turn-logger.js` / `intent-tracker.js`
which are already in the image.

## Cell plan

24 cells = 2 models × 4 techniques × 3 configurations. Single-run primary
estimates at n=30 per cell (matching the paper's existing per-cell n).
Variance is G2/G3's job, not G1's.

| # | Model        | Technique | Config | Reps | Walltime per cell |
|---|--------------|-----------|--------|-----:|------------------:|
| 1–3   | gpt-4o-mini  | T1       | C1' / C3' / C4'  |   30 | ~1 h |
| 4–6   | gpt-4o-mini  | T3       | C1' / C3' / C4'  |   30 | ~2 h |
| 7–9   | gpt-4o-mini  | T4       | C1' / C3' / C4'  |   30 | ~1 h |
| 10–12 | gpt-4o-mini  | T8       | C1' / C3' / C4'  |   30 | ~1.5 h |
| 13–15 | gpt-4o       | T1       | C1' / C3' / C4'  |   30 | ~2 h |
| 16–18 | gpt-4o       | T3       | C1' / C3' / C4'  |   30 | ~4 h |
| 19–21 | gpt-4o       | T4       | C1' / C3' / C4'  |   30 | ~2 h |
| 22–24 | gpt-4o       | T8       | C1' / C3' / C4'  |   30 | ~3 h |

**T1** = document injection; **T3** = multi-turn goal hijacking; **T4** =
HTTP-response payload splitting; **T8** = task-description injection.
These four are the reviewer-named subset. Existing scenarios are in
`scenarios/t{1,3,4,8}-*.ts` (some of these — T1, T8 — are not yet wired
into runner-p14's `TECHNIQUES` switch; T1 and T8 dispatch needs to be
added alongside the existing T3 / T3e / T4 / T5 paths, ~30 min in
`runner-p14.ts:executeAll`).

**Priority order if walltime is tight:**

1. T3 × C4' on both models (the headline result; mirrors what qwen3 has).
2. T1 + T8 × C4' on both models (the missing techniques across cross-vendor).
3. T4 × C4' on both models (low-priority — Sonnet T4 already ceilinged
   at GES=100; cross-vendor likely similar).
4. Full C1' / C3' rows (the factorial decomposition's strongest claim
   needs all three configurations).

Walltime totals: gpt-4o-mini full sweep ~17 h; gpt-4o full sweep ~33 h.
With two parallel containers (one per model), total wall time ~33 h.

## Container env payloads

The test22 entrypoint's existing env vars (`TEST22_MODELS`,
`TEST22_TECHNIQUES`, `TEST22_DEFENCES`, `TEST22_REPS`, etc.) cover the
matrix. The only addition for OpenAI is `OPENAI_API_KEY` and the
explicit `TEST22_AGENT_BACKEND=openai`.

Skeleton `/run` payload (one cell per request — failures in one cell
don't stall the others):

```bash
RUN_TS="$(date -u '+%Y%m%dT%H%M%SZ')"
HOST="https://bedtA.aisandbox.dev.ckotech.internal"   # change per cell
DREDD_KEY="$(cat ~/.claude/dredd/api-key)"
OPENAI_KEY="$(cat /Users/adrian/IdeaProjects/JudgeAIDredd/openapi.key)"

# === Cell 4: gpt-4o-mini / T3 / C1' / 30 reps =======================
curl -sk -X POST "$HOST/run" -H 'content-type: application/json' \
  -d @- <<EOF
{
  "test": "test22",
  "env": {
    "TEST22_RUN_ID":     "G1-gpt-4o-mini-T3-C1prime-${RUN_TS}",
    "TEST22_MODELS":     "gpt-4o-mini",
    "TEST22_TECHNIQUES": "T3",
    "TEST22_DEFENCES":   "C1-baseline,C1-judge",
    "TEST22_REPS":       "30",
    "TEST22_AGENT_BACKEND": "openai",
    "OPENAI_API_KEY":    "${OPENAI_KEY}",
    "AWS_REGION":        "eu-west-2",
    "AGENT_REGION":      "eu-west-1",
    "DREDD_URL":         "https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal",
    "DREDD_API_KEY":     "${DREDD_KEY}",
    "RESULTS_S3_URL":    "s3://cko-results/test22/G1-gpt-4o-mini-T3-C1prime-${RUN_TS}"
  }
}
EOF
```

Repeat with `TEST22_MODELS=gpt-4o`, `TEST22_TECHNIQUES=T{1,3,4,8}`,
`TEST22_DEFENCES=C4-baseline,C4-judge` (for C4'), or
`TEST22_DEFENCES=C3-baseline,C3-judge` (for C3'; needs runner-p14 to
recognise C3-* arms — currently only C1-* and C4-* are wired). C3'
support requires an additional runner change:

### P4. Add C3' (no system prompt, with approval) defence arm to runner-p14

`runner-p14.ts` currently builds the 4-arm matrix as
`{C4-baseline, C4-judge, C1-baseline, C1-judge}` (see `executeAll` and
`DEFENCES` parsing at line ~71). Add `C3-baseline` and `C3-judge` cases
that pass `systemPrompt=undefined` (matching C4) but route through the
approval/judge pipeline (matching C1-judge). Without this, C3' cannot be
distinguished from C4' in the cell-naming, and the factorial
decomposition can't separate "no system prompt" from "no approval".

Effort: ~20 min. After this, the same `/run` payload above with
`TEST22_DEFENCES=C3-baseline,C3-judge` produces the C3' cell.

## Provenance / housekeeping

- **Key file**: `/Users/adrian/IdeaProjects/JudgeAIDredd/openapi.key`.
  165 bytes, single-line. Untracked, `.gitignore` already excludes
  `openapi.key` (verified 2026-05-24).
- **Connectivity test (2026-05-24)**: 124 models accessible including
  `gpt-4o-mini-2024-07-18` and `gpt-4o-2024-08-06`; chat-completions
  scope confirmed (ping → "Pong!", 8/3 token usage).
- **Cost ceiling**: gpt-4o-mini input $0.150/1M, output $0.600/1M.
  gpt-4o input $2.50/1M, output $10.00/1M. The full 24-cell sweep at
  ~50K tokens per rep × 30 reps × 24 cells ≈ 36M tokens. Worst case
  (gpt-4o, half-half input/output): ~$220. gpt-4o-mini half: ~$14.
  Total budget envelope: under $250.

## Out of scope for this doc

- Variance (G2 for T4, G3 for T3 — separate docs).
- T5 (multi-stage), T6 / T7 / T9–T11. The reviewer named only
  T1/T3/T4/T8; restricting scope keeps the cost envelope and walltime
  manageable. If subsequent reviewers ask for more techniques, the
  matrix extends naturally — same payload shape, more cells.
- AgentDojo / AgentLAB / MT-AgentRisk cross-vendor — those already have
  gpt-4o-mini coverage from prior commits. This doc is about closing the
  test22 P14 harness gap specifically.
