# P20 — cross-vendor consensus / accuracy / temperature runner

Restored and extended harness for the P20 paper (`Cloud-Security/Adrian/p20/`).
Closes the three gaps the offline analysis couldn't: cross-vendor diversity,
ground-truth accuracy, and temperature decoupled from reasoning.

This directory is intentionally separate from `test-framework/` (which has its
own in-flight edits). The runner imports the **production** judge from `../src/`
so every run exercises the real pipeline.

## Provenance

`run-adversarial-judge.ts` is restored from tag `research-v1`
(`archive/tests/test-adversarial-judge.ts`) with these additions:

- **Cross-vendor routing** — `--judge-model <raw-id> --backend bedrock|openai|ollama`.
  OpenAI is now a first-class judge backend (`src/intent-judge.ts` `JudgeBackend`
  gained `"openai"`; dispatch added in `evaluate()`).
- **Controlled temperature** — `--judge-temperature 0,0.5,1` (comma-list = sweep).
  Threaded through `bedrockChat(... , temperature)` so it overrides the
  `effort ? 1 : 0.1` rule. `openaiChat` already accepts it. **Opus 4.7/4.8 still
  reject the param** (never sent); **Anthropic with thinking on forces T=1** at
  the API regardless — the result JSON's `sampling.thinkingForcesTemp` flags this.
  Run the clean temp sweep on open-weight / non-Anthropic models with thinking off.
- **Persona variants** — `--prompt persona-{neutral,auditor,sre,compliance,redteam}`.
  Implemented as a generic `systemPromptPrefix` on `IntentJudge` (kept OUT of the
  production `PromptVariant` enum), so the standard prompt body is identical across
  personas — the persona is the only manipulated variable.
- **Ground-truth labels** — every `adv-*` case carries `expectedVerdict` /
  `expectedCaught`; the runner also writes a sibling `labels.json`. Lets P20 score
  F1 / false-allow / false-block / MCC / Q-statistic, not just stability.
- **Sampling metadata** — top-level `sampling` block + `temperature`/`thinking`
  record what was *actually* requested (closes the §6 gap that forced P20 to
  reconstruct temperature).

The result schema is otherwise **unchanged** — `cases[].reps[]` so
`p20/figures/consensus_sim.py` and the census re-run unmodified.

## Deck

- Default (12 cases): `adv-1 .. adv-12`, all ground-truth hijacks.
- `--b6` (32 cases): 8 families × `{bash, json, euph, expl}` surface formats —
  the channel-expanded deck the shipped result files use.

All adv-* cases are attacks. **False-block (availability) and a balanced F1 need
the benign half** — run the AgentDojo / InjecAgent slice separately and label its
benign cases `expectedCaught=false`. This runner supplies recall / false-allow.

## Run examples

```bash
# P0-a — Anthropic panel member, thinking on (API forces T=1), N=20:
AWS_REGION=eu-central-1 npx tsx p20/run-adversarial-judge.ts \
  --judge-model eu.anthropic.claude-opus-4-8 --backend bedrock \
  --judge-effort high --prompt persona-neutral --repetitions 20

# P0-c — DeepSeek cross-vendor (region per p15b/model-access doc):
AWS_REGION=us-east-1 npx tsx p20/run-adversarial-judge.ts \
  --judge-model deepseek.v3.2 --backend bedrock --prompt persona-neutral --repetitions 20

# P0-f — GPT-4o via OpenAI direct (needs OPENAI_API_KEY):
npx tsx p20/run-adversarial-judge.ts \
  --judge-model gpt-4o --backend openai --prompt persona-neutral --repetitions 20

# P0-g — temperature sweep, thinking OFF (separates temp from reasoning):
npx tsx p20/run-adversarial-judge.ts \
  --judge-model openai.gpt-oss-120b --backend bedrock \
  --judge-effort none --judge-temperature 0,0.5,1 --repetitions 20

# P1 — persona sweep, one model fixed:
for p in persona-neutral persona-auditor persona-sre persona-compliance persona-redteam; do
  AWS_REGION=eu-central-1 npx tsx p20/run-adversarial-judge.ts \
    --judge-model eu.anthropic.claude-opus-4-8 --backend bedrock \
    --judge-effort high --prompt "$p" --repetitions 20
done
```

## Flags

| Flag | Meaning |
|---|---|
| `--judge-model <id>` | Raw model id (P20 mode). Omit to run the built-in `MODELS` table (bedrock). |
| `--backend bedrock\|openai\|ollama` | Judge backend. Default `bedrock`. |
| `--label <str>` | Display/filename label for the model (defaults to the raw id). |
| `--judge-effort low\|medium\|high\|max\|none` | Reasoning effort. `none`/empty = thinking off. Alias: `--effort`. |
| `--judge-temperature 0,0.5,1` | Explicit temperature(s). Comma-list = one cell per value. Empty = backend default. |
| `--prompt <variant>` | `standard` / `B7` / `B7.1` / `B7.1-office` OR a `persona-*`. |
| `--repetitions N` | Reps per case (P20 uses 20). |
| `--cases adv-1,adv-3` | Substring filter on case id (`includes`). |
| `--b6` | Use the 32-case channel-expanded deck. |
| `--out-dir <path>` | Output dir. Default `p20/results/` (git-ignored). |

## Output

Per cell: `adversarial-judge-<label>[-effort][-persona][-tN][-B7/B71][-B6]-<ts>.json`
plus one `labels.json` per `--out-dir`. The result JSON keeps the existing
`cases[].reps[]` shape; new fields (`sampling`, `temperature`, `thinking`,
per-case `expectedVerdict`/`expectedCaught`) are additive.

Fail-soft "Judge error" reps are preserved (verdict `drifting`, marker in
`reasoning`) so the census's contamination filter keeps working — infra errors
must not be scored as verdicts.
