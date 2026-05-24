# A/B prompt-count harness

Compares Claude Code permission/denial counts on a fixed 14-step task with
and without the deployed Judge AI Dredd hook in the loop.

- **Variant `baseline`** — empty allowlist, `disableAllHooks: true`.
- **Variant `dredd`** — empty allowlist, all five hook events wired to
  `hooks/dredd-hook.sh`, which talks to the deployed sandbox.

Both variants use Bedrock for the model (`CLAUDE_CODE_USE_BEDROCK=1`) so the
operator's local AWS profile must have `bedrock:InvokeModel` permission on
`eu.anthropic.claude-sonnet-4-6` in `eu-west-2`.

## Run it

```bash
export DREDD_API_KEY=$(cat /Users/adrian.asher/IdeaProjects/JudgeAIDredd/test.key)
unset AWS_BEARER_TOKEN_BEDROCK ANTHROPIC_API_KEY     # both shadow Bedrock SigV4
REPEATS=3 ./run.sh
```

Artefacts land in `results/`:
- `<variant>-<n>-<stamp>.jsonl` — raw stream-json transcript
- `<variant>-<n>-<stamp>.csv` — per-tool-call outcomes
- `<variant>-<n>-<stamp>.summary.json` — counts + result-event metadata
- `ab-results.csv` — consolidated summary across all runs

## How it works

`drive.mjs` spawns one `claude` process per run with
`--input-format stream-json --output-format stream-json` and feeds it the 14
steps from `task.json` one user message per turn, advancing on the next
`result` event. The driver enforces step-level and hard timeouts.

`parse.mjs` walks each transcript: every `tool_use` block from the assistant
is matched to its `tool_result` block from the user, and we classify each
match as ok / permission-denied (regex on `is_error: true` results) /
errored-other. The `result` event's `permission_denials` field is also
captured as a sanity cross-check.

## Known behaviour

- The deployed Dredd is **stateful** — sessions are persisted in DynamoDB.
  Re-running won't pollute your local machine. To inspect a run on the
  dashboard, log in with an admin account; the API-keyed sessions surface
  under their `ownerSub`.
- The `dredd` variant always sends `DREDD_MODE=interactive` per request so
  whatever global trust mode the sandbox has set won't perturb the run.
- Model non-determinism is the dominant noise source. Run `REPEATS=5+`
  before drawing conclusions.
