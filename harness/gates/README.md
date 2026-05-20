# Pre-flight gates

Run these before launching any multi-benchmark Dredd evaluation campaign.
Halt at the first failure. Each gate maps to one entry in
`TEST_REQUIREMENTS.md`. Total spend is well under $1 even in the worst
case.

## GATE-0 — flag pin

```bash
MODE=autonomous BACKEND=bedrock \
  JUDGE_MODEL=eu.anthropic.claude-sonnet-4-6 \
  EMBEDDING_MODEL=eu.cohere.embed-v4:0 \
  HARDENED=B7.1 STORE_BACKEND=dynamo \
  DREDD_USER_PERMISSIONS_ENABLED=true \
  DREDD_PATTERN_LEARNING_ENABLED=false \
  DREDD_PATTERN_LEARNING_HARD_ENABLED=false \
  DREDD_MANAGED_ALLOW_SCOPE=conservative \
  harness/gates/gate-0-flags.sh
```

Refuses to launch unless every Dredd tunable is set explicitly. Pass
`--json` to get a payload suitable for `metadata.json.feature_flags`.
Cost: zero.

## GATE-1 — policy truth table

```bash
npx tsx harness/gates/gate-1-policy.ts
```

Pure unit test — no Bedrock, no Ollama. Drives `evaluateToolPolicy()`
with the inputs listed in `TEST_REQUIREMENTS.md` GATE-1. Cost: zero.

## GATE-2 — embedding-drift sanity

```bash
EMBEDDING_MODEL=eu.cohere.embed-v4:0 AWS_REGION=eu-west-2 \
  npx tsx harness/gates/gate-2-drift.ts
```

Embeds two fixed pairs and asserts cosine sits in the expected band.
Detects regressed/wrong-dimension embedding backends. Cost on Bedrock:
~$0.005 per run. Set `EMBEDDING_MODEL=nomic-embed-text` to run against
Ollama instead.

## GATE-3 — judge sanity

```bash
JUDGE_MODEL=eu.anthropic.claude-sonnet-4-6 BACKEND=bedrock HARDENED=B7.1 \
  AWS_REGION=eu-west-2 \
  npx tsx harness/gates/gate-3-judge.ts
```

Invokes the judge on a known-on-task trajectory and a known-hijack
trajectory. Cost on Bedrock: ~$0.01 per run. Use `BACKEND=ollama
JUDGE_MODEL=llama3.2` for a free local check.

## All four together

```bash
harness/gates/gate-0-flags.sh && \
  npx tsx harness/gates/gate-1-policy.ts && \
  npx tsx harness/gates/gate-2-drift.ts && \
  npx tsx harness/gates/gate-3-judge.ts
```

Exit 0 means the campaign is safe to launch. Exit non-zero halts —
investigate before burning campaign budget.

## Notes

- `AWS_BEARER_TOKEN_BEDROCK` (if set in your shell from an earlier
  Bedrock playground session) silently overrides IAM credentials and
  produces opaque 403s. Gates 2 and 3 strip it on entry; if you see
  unexpected `AccessDeniedException`s elsewhere, `unset` it first.
- GATE-2 and GATE-3 ceiling/floor thresholds are loose by design — the
  point is to catch regressed backends, not to calibrate the four-band
  drift mapping.
