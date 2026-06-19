#!/usr/bin/env bash
# P20 adversarial-judge runner entrypoint.
#
# Drives p20/run-adversarial-judge.ts — the cross-vendor consensus / accuracy /
# temperature study (docs/test-request-p20-consensus-2026-06-18.md). UNLIKE the
# t5/t3e suites, this is a PURE JUDGE EVALUATION: it instantiates IntentJudge
# in-process over the adv-* deck and records per-(model,case) reps[]. There is
# NO agent loop, NO canary server, NO /etc/hosts mapping — the "attack" is the
# static deck, so the only network egress is the judge's own Bedrock/OpenAI call.
#
# Cell matrix (env):
#   JUDGE_MODEL       raw model id, e.g. eu.anthropic.claude-opus-4-8 / deepseek.v3.2 / gpt-4o
#   JUDGE_BACKEND     bedrock | openai | ollama         (default: bedrock)
#   JUDGE_EFFORT      none | low | medium | high | max  (default: none = thinking off)
#   JUDGE_TEMPERATURE comma-list sweep e.g. 0,0.5,1     (default: unset = backend default)
#   JUDGE_PROMPT      standard|B7|B7.1|B7.1-office OR persona-{neutral,auditor,sre,compliance,redteam}
#   REPETITIONS       int                               (default: 20)
#   CASES             substring filter e.g. adv-1,adv-3 (default: all)
#   B6                "true" → 32-case channel-expanded deck (default: 12-case base)
#   DECK              adv | benign | mixed              (default: adv)
#                       adv    = hijack deck (recall / false-allow)
#                       benign = InjecAgent + security-adjacent (false-block / availability)
#                       mixed  = both, one balanced cell → recall AND false-block
#   LABEL             display/filename label            (default: the raw model id)
#
# Required env:
#   AWS_REGION        region for the Bedrock judge (eu-central-1 / us-east-1 / us-west-2 …)
# Optional:
#   RUN_ID            defaults to p20-<utc>
#   OPENAI_API_KEY    required only for JUDGE_BACKEND=openai (openapi.key)
#   RESULTS_S3_URL    default s3://cko-results/p20/<RUN_ID>
#   DRY_RUN=1
#
# The runner emits one result JSON per (model × temperature) cell plus one
# labels.json, all under $LOGDIR — synced to S3 at run end (same survive-on-disk
# semantics as t5: cleaned at the START of the next run, recoverable via /files).

set -euo pipefail

log()  { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FATAL: $*" >&2; exit 1; }

: "${AWS_REGION:?AWS_REGION must be set (Bedrock region for the judge)}"

RUN_ID="${RUN_ID:-p20-$(date -u '+%Y%m%dT%H%M%SZ')}"
JUDGE_MODEL="${JUDGE_MODEL:?JUDGE_MODEL must be set (raw model id)}"
JUDGE_BACKEND="${JUDGE_BACKEND:-bedrock}"
JUDGE_EFFORT="${JUDGE_EFFORT:-none}"
JUDGE_TEMPERATURE="${JUDGE_TEMPERATURE:-}"
JUDGE_PROMPT="${JUDGE_PROMPT:-persona-neutral}"
REPETITIONS="${REPETITIONS:-20}"
CASES="${CASES:-}"
DECK="${DECK:-adv}"
LABEL="${LABEL:-}"
LOGDIR="${P20_LOGDIR:-/app/runs}"
mkdir -p "$LOGDIR"

# Clean at run START (not end) — mirrors t5: prior run's per-cell JSON survives
# on disk (GET /files) until the next run begins, regardless of S3-push outcome.
log "cleaning $LOGDIR at run start (prior run's files were preserved until now)"
rm -rf "${LOGDIR:?}"/* 2>/dev/null || true

RESULTS_S3_URL="${RESULTS_S3_URL:-s3://cko-results/p20/${RUN_ID}}"
if [[ "${RESULTS_S3_DISABLE:-0}" == "1" ]]; then RESULTS_S3_URL=""; fi

log "─── P20 Adversarial Judge Runner ───────────────────────────────"
log "RUN_ID=$RUN_ID"
log "AWS_REGION=$AWS_REGION"
log "JUDGE_MODEL=$JUDGE_MODEL  JUDGE_BACKEND=$JUDGE_BACKEND"
log "JUDGE_EFFORT=$JUDGE_EFFORT  JUDGE_TEMPERATURE=${JUDGE_TEMPERATURE:-(backend default)}"
log "JUDGE_PROMPT=$JUDGE_PROMPT  REPETITIONS=$REPETITIONS  CASES=${CASES:-(all)}  B6=${B6:-false}  DECK=$DECK"
log "OPENAI_API_KEY=$([[ -n "${OPENAI_API_KEY:-}" ]] && echo set || echo unset)"
log "LOGDIR=$LOGDIR  RESULTS_S3_URL=${RESULTS_S3_URL:-(disabled)}"
log "────────────────────────────────────────────────────────────────"

if [[ "$JUDGE_BACKEND" == "openai" && -z "${OPENAI_API_KEY:-}" ]]; then
  log "WARN: JUDGE_BACKEND=openai but OPENAI_API_KEY is unset — every rep will fail-soft to 'drifting' (Judge error)."
fi

runner_args=(
  --judge-model "$JUDGE_MODEL"
  --backend "$JUDGE_BACKEND"
  --judge-effort "$JUDGE_EFFORT"
  --prompt "$JUDGE_PROMPT"
  --repetitions "$REPETITIONS"
  --deck "$DECK"
  --out-dir "$LOGDIR"
)
[[ -n "$JUDGE_TEMPERATURE" ]] && runner_args+=( --judge-temperature "$JUDGE_TEMPERATURE" )
[[ -n "$CASES" ]]            && runner_args+=( --cases "$CASES" )
[[ -n "$LABEL" ]]            && runner_args+=( --label "$LABEL" )
[[ "${B6:-false}" == "true" ]] && runner_args+=( --b6 )

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log "DRY_RUN: cd /app && node test-framework/node_modules/tsx/dist/cli.mjs p20/run-adversarial-judge.ts ${runner_args[*]}"
  exit 0
fi

# Run from /app so the runner's ../src/ imports resolve (it lives at /app/p20/,
# src at /app/src/). tsx + the AWS SDK come from the vendored test-framework
# node_modules, reachable via the /app/node_modules symlink.
cd /app
exec_rc=0
AWS_REGION="$AWS_REGION" BEDROCK_REGION="${BEDROCK_REGION:-$AWS_REGION}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  node test-framework/node_modules/tsx/dist/cli.mjs p20/run-adversarial-judge.ts "${runner_args[@]}" || exec_rc=$?

if [[ -n "$RESULTS_S3_URL" ]]; then
  log "s3 push: $LOGDIR -> $RESULTS_S3_URL"
  push_rc=0
  aws s3 sync "$LOGDIR/" "$RESULTS_S3_URL/" --no-progress || push_rc=$?
  if [[ "$push_rc" == "0" ]]; then
    log "s3 push OK — files left on disk for inspection; cleaned at next run start"
  else
    log "s3 push: failed (rc=$push_rc) — results stay local (recover via /files)"
  fi
fi

exit $exec_rc
