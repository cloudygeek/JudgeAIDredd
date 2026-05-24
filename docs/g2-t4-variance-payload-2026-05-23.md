# G2 — Sonnet T4 variance — /run payloads

Date: 2026-05-23
Reviewer: R2.2 — "Please also extend the variance analysis to T4, which
shows one of the largest single-configuration drops in the primary
results and is currently unexamined."
Source gap: `docs/p14-reviewer-gaps-2026-05-22.md` §G2.

This file gives the **container env payloads** to drive 90-rep T4
variance sweeps on Sonnet-4.6 against the rebuilt `test-framework`
image (v0.1.431+). The earlier on-disk corpus
(`results/test22/2026{0429T121720Z,0429T141836Z,0429T141853Z,0429T142013Z}/`,
4800 attempted Sonnet × T4 × 4-arm runs at n=100 each) was poisoned —
every run errored with `Claude Code native binary not found at
/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude`
and produced zero tool calls, so the GES=100 / dipP=1.0 numbers from
those JSONs are non-results. Pooled JSONs from that corpus were deleted
on 2026-05-23.

## Image build (one-time)

`judge-ai-dredd-test-framework.zip` (built 2026-05-23, version 0.1.431)
is what's needed. The Dockerfile and build script were extended in
commit `5b3b1cb1` to:

- COPY `archive/`, `scenarios/`, `src/` into `/app/` (sources of
  `archive/tests/runner-p14.ts` and its transitive imports — the runner
  lives outside `test-framework/`).
- Symlink `/app/node_modules` → `/app/test-framework/node_modules` so
  `npx tsx archive/tests/runner-p14.ts` resolves the SDK + tsx at
  runtime without a separate `npm install`.
- Default `--agent-backend converse` in the test22 entrypoint so Sonnet
  / Opus / Haiku route through the AWS CLI Bedrock Converse path
  (`aws bedrock-runtime converse`) rather than the
  `@anthropic-ai/claude-agent-sdk` Node import that needs the
  linux-x64-musl native binary baked into `/app/node_modules/`.
- Extend `archive/tests/executor-converse.ts`'s `MODEL_MAP` with
  Anthropic aliases (`claude-sonnet-4-6`, `claude-opus-4-7`,
  `claude-opus-4-6`, `claude-haiku-4-5`).

Operator steps to land the image:

1. Upload `/Users/adrian.asher/IdeaProjects/JudgeAIDredd/judge-ai-dredd-test-framework.zip`
   via the AI Sandbox UI's CodeBuild source-upload form.
2. CodeBuild will build + push to ECR.
3. Update an idle bedt task definition (e.g. one currently pointing at
   the previous `test-framework` image tag) to the new tag.

## Acceptance test (from p14-reviewer-gaps)

> Bimodality verdict (reject / fail to reject unimodality) for T4 at
> C1 and C4, reported with the same statistics as Sonnet T3 in
> Finding 1.

## Cell plan

Two cells, one model × two defences, 90 reps each. Container split
optional — both cells can run on the same container sequentially.

| # | Container  | AGENT_MODEL      | DEFENCE       | Reps | Walltime |
|---|------------|------------------|---------------|-----:|---------:|
| 1 | bedtA      | claude-sonnet-4-6| C4-baseline   |   90 | ~5–6 h   |
| 2 | bedtA      | claude-sonnet-4-6| C4-judge      |   90 | ~6–7 h   |
| 3 | bedtB      | claude-sonnet-4-6| C1-baseline   |   90 | ~5–6 h   |
| 4 | bedtB      | claude-sonnet-4-6| C1-judge      |   90 | ~6–7 h   |

**Priority cells**: 1 + 2. The reviewer's specific ask is C1 vs C4
on T4 — but Finding 1's bimodality claim is about the undefended
distribution (C4-baseline), and the defence-induced split that fell
out of G3 (Sonnet T3.4 / intent-tracker becoming bimodal) is what
makes the C4-judge cell informative. C1 cells are the bracket; if
walltime is tight, run C4 first.

The runner already loops the 4-arm matrix per `TEST22_DEFENCES`, so a
single `/run` issues 90 reps × 3 T4 variants × all selected arms in one
container slot. With `TEST22_REPS=90 TEST22_DEFENCES=C4-baseline,C4-judge`
the C4 pair runs together; flip to `C1-baseline,C1-judge` for the C1
pair.

## Container payloads

All payloads assume:

- `DREDD_AUTH_MODE=optional` on the target Dredd hook (per
  `feedback_runs_auth_optional`). G2 payloads don't talk to Dredd's
  hook directly (no DREDD_URL needed), but the test22 runner does run
  IntentTracker against Bedrock for the `*-judge` arms.
- Bedrock + AWS creds available on the container's task role.
- For Anthropic Bedrock models, `AWS_REGION=eu-west-2` (Anthropic
  inference profiles live in eu-west-2; the entrypoint preflights
  `claude-sonnet-4-6` against this region).

### Cell payloads (curl-ready)

```bash
RUN_TS="$(date -u '+%Y%m%dT%H%M%SZ')"
HOST="https://bedtA.aisandbox.dev.ckotech.internal"   # change per cell

# === Cell 1+2 (C4 pair): claude-sonnet-4-6 / T4 / {baseline,judge} =====
# 90 reps × 3 T4 variants × 2 defences = 540 runs ≈ 11–13h walltime.
# (Reduce to TEST22_REPS=45 if a single 11h budget is too long; the
#  bimodality test still works at n=45 per cell.)
curl -sk -X POST "$HOST/run" -H 'content-type: application/json' \
  -d @- <<EOF
{
  "test": "22",
  "env": {
    "TEST22_RUN_ID":     "G2-sonnet-T4-C4-${RUN_TS}",
    "TEST22_MODELS":     "claude-sonnet-4-6",
    "TEST22_TECHNIQUES": "T4",
    "TEST22_DEFENCES":   "C4-baseline,C4-judge",
    "TEST22_REPS":       "90",
    "TEST22_MAX_TURNS":  "10",
    "TEST22_AGENT_BACKEND": "converse",
    "AWS_REGION":        "eu-west-2",
    "JUDGE_REGION":      "eu-central-1",
    "S3_BUCKET":         "cko-results",
    "S3_PREFIX":         "test22",
    "S3_REGION":         "eu-west-1"
  }
}
EOF

# === Cell 3+4 (C1 pair): claude-sonnet-4-6 / T4 / {baseline,judge} =====
HOST="https://bedtB.aisandbox.dev.ckotech.internal"   # different container
curl -sk -X POST "$HOST/run" -H 'content-type: application/json' \
  -d @- <<EOF
{
  "test": "22",
  "env": {
    "TEST22_RUN_ID":     "G2-sonnet-T4-C1-${RUN_TS}",
    "TEST22_MODELS":     "claude-sonnet-4-6",
    "TEST22_TECHNIQUES": "T4",
    "TEST22_DEFENCES":   "C1-baseline,C1-judge",
    "TEST22_REPS":       "90",
    "TEST22_MAX_TURNS":  "10",
    "TEST22_AGENT_BACKEND": "converse",
    "AWS_REGION":        "eu-west-2",
    "JUDGE_REGION":      "eu-central-1",
    "S3_BUCKET":         "cko-results",
    "S3_PREFIX":         "test22",
    "S3_REGION":         "eu-west-1"
  }
}
EOF
```

## Smoke test before going to 90 reps

The earlier corpus's binary-not-found failure was silent — the runner
recorded `ges=100, hijackSucceeded=false` for every "run" that never
fired a tool call. To avoid burning 11+ hours on another silent
failure, kick a 5-rep smoke first and grep for "binary not found"
before the full 90:

```bash
curl -sk -X POST "$HOST/run" -H 'content-type: application/json' \
  -d @- <<EOF
{
  "test": "22",
  "env": {
    "TEST22_RUN_ID":     "G2-smoke-${RUN_TS}",
    "TEST22_MODELS":     "claude-sonnet-4-6",
    "TEST22_TECHNIQUES": "T4",
    "TEST22_DEFENCES":   "C4-baseline",
    "TEST22_REPS":       "5",
    "TEST22_AGENT_BACKEND": "converse",
    "AWS_REGION":        "eu-west-2",
    "JUDGE_REGION":      "eu-central-1",
    "S3_BUCKET":         "cko-results",
    "S3_PREFIX":         "test22"
  }
}
EOF
```

After it lands, verify on the synced JSONs:

```bash
python3 -c "
import json, glob
for p in glob.glob('results/test22/*G2-smoke*/p14-T4-*.json'):
    d = json.load(open(p))
    for r in d.get('runs', []):
        for t in r.get('turns', []):
            ar = t.get('assistantResponse','')
            if 'binary not found' in ar:
                print('FAIL:', p)
                break
        else:
            continue
        break
    else:
        print('OK:', p, 'tool_calls=', sum(len(t.get('toolCalls',[])) for r in d['runs'] for t in r.get('turns',[])))
"
```

If the smoke shows `tool_calls > 0` and zero `binary not found`
strings, the image is healthy and the 90-rep payloads above are safe
to issue.

## Post-run scoring

Once each S3 prefix lands locally
(`benchmarks/test-framework/runs/G2-sonnet-T4-C{1,4}-<ts>/` after a
sync from `s3://cko-results/test22/G2-sonnet-T4-*-<ts>/`):

```bash
# Pool per-arm into the test29-shape envelope so the same scripts work.
# (See /tmp/pool-t4-sonnet.py for the pattern; adapt the glob to the new
# G2-sonnet-T4 paths.)

# Per-cell decomposition — feeds the Table 8' replacement
python3 scripts/ges-decomp.py --csv g2-decomp.csv \
    benchmarks/test-framework/runs/G2-sonnet-T4-*/results-*.json

# Bimodality verdict — feeds the Finding 1 row for T4
python3 scripts/compute-bimodality.py --filter T4 --json g2-bimodal.json \
    benchmarks/test-framework/runs/G2-sonnet-T4-*/
```

Acceptance numbers to report in the manuscript (per arm):

- Sonnet-4.6 / C4-baseline / T4: n, mean GES, 95% CI, dip D, dip p, GMM weights
- Sonnet-4.6 / C4-judge / T4: same
- Sonnet-4.6 / C1-baseline / T4: same
- Sonnet-4.6 / C1-judge / T4: same

The earlier doc anticipated "C1 and C4 — bimodality verdict (reject /
fail to reject)". With G3 having shown the bimodality on Sonnet T3.4 is
defence-induced rather than intrinsic, the more interesting comparison
is C4-baseline (undefended baseline; should match the AgentDojo
xvendor T1/T3 pattern) vs C4-judge (defence-induced effect, mirrors
the G3 sonnet/intent-tracker finding). C1 cells then bracket whether
the system-prompt + sandbox layer changes the picture vs raw C4.
