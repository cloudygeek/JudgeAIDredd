# G2 — Sonnet T4 launch payloads (2026-05-27)

Companion to `docs/g2-sonnet-t4-rerun-spec-2026-05-27.md`. Curl-ready
/run payloads + the gate sequence (image flip → smoke → full).

## Pre-launch state (2026-05-27 ~13:00 UTC)

`scripts/bedt-status.sh` shows:

| bedt | image | last test | status | role |
|---|---|---|---|---|
| bedt3  | v0.1.460 | test-framework | done | cell 1 |
| bedt4  | v0.1.460 | test-framework | done | cell 2 |
| bedt5  | v0.1.459 | test-framework | done | reserve |
| bedt14 | v0.1.460 | test-framework | done | reserve |

The test-framework zip ships both the test-framework and the test22
entrypoints in one image (`fargate/Dockerfile.test-framework-zip`
copies in `/docker-entrypoint-test22.sh` and
`/docker-entrypoint-test-framework.sh` side-by-side). The api-server
routes `{"test":"22",...}` payloads to the test22 entrypoint. So
**v0.1.460 already accepts test22 payloads** — `last test = test-framework`
just reports which entrypoint was last invoked. No image flip, no new
zip. (The two post-v0.1.460 commits touch test-framework code only,
not the archive/tests/ test22 path.)

## Common variables

```bash
RUN_TS=$(date -u +%Y%m%dT%H%M%SZ)
# e.g. RUN_TS=20260527T130000Z
HOST_C1="https://bedt3.aisandbox.dev.ckotech.internal"   # cell 1: C4-baseline + C1-baseline
HOST_C2="https://bedt4.aisandbox.dev.ckotech.internal"   # cell 2: C4-judge + C1-judge
```

## Step 0 — Confidence probe (no flip, just a /status read)

```bash
for HOST in "$HOST_C1" "$HOST_C2"; do
  echo "=== $HOST ==="
  curl -sk -m 5 "$HOST/status" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('image =', d.get('version'))   # expect 0.1.460 (≥0.1.446 has converse executor)
print('status=', d.get('status'))    # expect done|idle|failed (i.e. free)
"
done
```

If both report `status=done` (or `idle`/`failed`) and `image≥0.1.446`,
proceed straight to Step 1. The smoke run in Step 1 is what actually
exercises the test22 path; this probe is informational.

## Step 1 — Smoke gate (1 rep, ~2 min)

Run on bedt3 first. Pass = no native-binary / API-error / UND_ERR
strings, tc/run > 0, walltime ~60–120 s.

```bash
curl -sk -X POST "$HOST_C1/run" -H 'content-type: application/json' \
  -d @- <<EOF
{
  "test": "22",
  "env": {
    "TEST22_RUN_ID":     "G2-sonnet-T4-SMOKE-${RUN_TS}",
    "TEST22_MODELS":     "claude-sonnet-4-6",
    "TEST22_TECHNIQUES": "T4",
    "TEST22_DEFENCES":   "C4-baseline",
    "TEST22_REPS":       "1",
    "TEST22_MAX_TURNS":  "10",
    "TEST22_AGENT_BACKEND": "converse",
    "RUNNER_CONCURRENCY": "1",
    "AWS_REGION":        "eu-west-2",
    "JUDGE_REGION":      "eu-central-1",
    "S3_BUCKET":         "cko-results",
    "S3_PREFIX":         "test22",
    "S3_REGION":         "eu-west-1"
  }
}
EOF
```

Watch the container's status until `done`:

```bash
while :; do
  S=$(curl -sk -m 5 "$HOST_C1/status" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status'))")
  echo "$(date -u +%H:%M:%S) $S"
  [ "$S" = "done" ] && break
  sleep 30
done
```

Sync the smoke result and validate:

```bash
aws s3 sync "s3://cko-results/test22/G2-sonnet-T4-SMOKE-${RUN_TS}/" \
            "results/test22/G2-sonnet-T4-SMOKE-${RUN_TS}/"

python3 - <<PY
import json,glob,statistics
DIR="results/test22/G2-sonnet-T4-SMOKE-${RUN_TS}"
rows=[]
for f in glob.glob(DIR+"/*.json"):
    d=json.load(open(f))
    if isinstance(d,dict) and "runs" in d: rows+=d["runs"]
n=len(rows)
errs=['native binary','API Error','UND_ERR_INVALID_ARG']
err=sum(1 for r in rows if any(any(e in (str(t.get('assistantResponse')) or '') for e in errs) for t in r.get('turns',[])))
tc=[sum(len(t.get('toolCalls',[])) for t in r.get('turns',[])) for r in rows]
print(f"n={n} err={err} tc/run={statistics.mean(tc):.1f}")
print("PASS" if err==0 and statistics.mean(tc)>0 else "FAIL — investigate before launching full run")
PY
```

## Step 2 — Cell 1 launch (C4-baseline + C1-baseline, n=90)

```bash
curl -sk -X POST "$HOST_C1/run" -H 'content-type: application/json' \
  -d @- <<EOF
{
  "test": "22",
  "env": {
    "TEST22_RUN_ID":     "G2-sonnet-T4-C4C1-baseline-n90-${RUN_TS}",
    "TEST22_MODELS":     "claude-sonnet-4-6",
    "TEST22_TECHNIQUES": "T4",
    "TEST22_DEFENCES":   "C4-baseline,C1-baseline",
    "TEST22_REPS":       "90",
    "TEST22_MAX_TURNS":  "10",
    "TEST22_AGENT_BACKEND": "converse",
    "RUNNER_CONCURRENCY": "2",
    "AWS_REGION":        "eu-west-2",
    "JUDGE_REGION":      "eu-central-1",
    "S3_BUCKET":         "cko-results",
    "S3_PREFIX":         "test22",
    "S3_REGION":         "eu-west-1"
  }
}
EOF
```

Total reps: 2 arms × 3 scenarios × 90 reps = 540. ETA ~3–5 h with K=2.

## Step 3 — Cell 2 launch (C4-judge + C1-judge, n=90)

Run in parallel on bedt4 once Step 0 confirms its image. The judge
arms add ~20 % wall time per turn (extra Bedrock Sonnet judge call
per tool result), so ETA ~4–6 h.

```bash
curl -sk -X POST "$HOST_C2/run" -H 'content-type: application/json' \
  -d @- <<EOF
{
  "test": "22",
  "env": {
    "TEST22_RUN_ID":     "G2-sonnet-T4-C4C1-judge-n90-${RUN_TS}",
    "TEST22_MODELS":     "claude-sonnet-4-6",
    "TEST22_TECHNIQUES": "T4",
    "TEST22_DEFENCES":   "C4-judge,C1-judge",
    "TEST22_REPS":       "90",
    "TEST22_MAX_TURNS":  "10",
    "TEST22_AGENT_BACKEND": "converse",
    "RUNNER_CONCURRENCY": "2",
    "AWS_REGION":        "eu-west-2",
    "JUDGE_REGION":      "eu-central-1",
    "S3_BUCKET":         "cko-results",
    "S3_PREFIX":         "test22",
    "S3_REGION":         "eu-west-1"
  }
}
EOF
```

## Step 4 — Sync + commit

```bash
for RID in \
  G2-sonnet-T4-C4C1-baseline-n90-${RUN_TS} \
  G2-sonnet-T4-C4C1-judge-n90-${RUN_TS}; do
  aws s3 sync "s3://cko-results/test22/$RID/" "results/test22/$RID/"
done

git add results/test22/G2-sonnet-T4-*-${RUN_TS}/
git commit -m "results: G2 Sonnet T4 variance n=90 (R2.2)"
git push origin HEAD:harness/agentlab-restore-and-fr4-adapters
```

## Step 5 — Validation + bimodality

See `docs/g2-sonnet-t4-rerun-spec-2026-05-27.md` §"Step 3 — Validation
+ bimodality (paste-ready)" — the per-arm + per-scenario validator and
the `compute-bimodality.py --filter T4.1/T4.2/T4.3` triple.

## Reserve fallbacks

- If bedt3 trips smoke gate, reuse the same payload against bedt5.
- If bedt4 trips smoke gate, reuse against bedt14.
- bedts 6–13, 15–17 are HTTP 503 at spec time (containers stopped) —
  spinning one up is also fine but expect ~3 min cold boot.
