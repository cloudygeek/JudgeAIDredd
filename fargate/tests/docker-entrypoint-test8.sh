#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 8 — Adversarial Judge Robustness (with effort sweep)
#
# Runs 12 adversarial cases × N models × M effort levels.
# Each model+effort combination runs sequentially (cheap, fast per case).
#
# Env overrides:
#   TEST8_MODELS    comma-separated model filters (default: all)
#   TEST8_EFFORT    effort levels (default: default,low,medium,high,max)
#   TEST8_REPS      repetitions per case (default: 1)
#   TEST8_HARDENED  if "true", use B7 hardened prompt
#   TEST8_PROMPT    prompt variant: standard, B7, B7.1 (overrides TEST8_HARDENED)
#   TEST8_B6        if "true", use B6 format-variant cases
#   S3_BUCKET       results bucket (default: cko-results)
#   S3_PREFIX       results prefix (default: test8)
# ============================================================================

LOG_FILE="/app/results/test8.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test8}"
EFFORT_LEVELS="${TEST8_EFFORT:-default,low,medium,high,max}"
REPETITIONS="${TEST8_REPS:-1}"
MODEL_FILTERS="${TEST8_MODELS:-}"
HARDENED="${TEST8_HARDENED:-false}"
PROMPT_VARIANT="${TEST8_PROMPT:-}"
B6="${TEST8_B6:-false}"

echo "============================================================"
echo " Test 8: Adversarial Judge Robustness"
echo " Effort levels: ${EFFORT_LEVELS}"
echo " Repetitions:   ${REPETITIONS}"
echo " Models:        ${MODEL_FILTERS:-all}"
echo " Hardened:      ${HARDENED}"
echo " S3: s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "============================================================"

# ── Preflight ──────────────────────────────────────────────────────────────
echo "Preflight: checking Bedrock access..."
aws bedrock-runtime converse \
  --region "${AWS_REGION:-eu-west-2}" \
  --model-id "eu.anthropic.claude-haiku-4-5-20251001-v1:0" \
  --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
  --inference-config '{"maxTokens":1}' \
  --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
  && echo "  Bedrock OK" \
  || { echo "  WARN: Bedrock preflight failed, continuing anyway"; }

echo "Preflight: checking S3 access (bucket: ${S3_BUCKET})..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${AWS_REGION:-eu-west-2}" --page-size 1 >/dev/null 2>&1 \
  && echo "  S3 list OK" \
  || { echo "  FATAL: Cannot list S3 bucket s3://${S3_BUCKET}/. Aborting."; exit 1; }

S3_TEST_KEY="${S3_PREFIX}/.preflight-$(date +%s)"
echo "preflight" | aws s3 cp - "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${AWS_REGION:-eu-west-2}" 2>/dev/null \
  && echo "  S3 write OK" \
  || { echo "  FATAL: Cannot write to S3 bucket. Aborting."; exit 1; }
aws s3 rm "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${AWS_REGION:-eu-west-2}" 2>/dev/null || true

# ── Run ────────────────────────────────────────────────────────────────────
IFS=',' read -ra EFFORTS <<< "${EFFORT_LEVELS}"

# If MODEL_FILTERS is set, split into an array; otherwise use a single empty entry (= all models)
if [ -n "${MODEL_FILTERS}" ]; then
  IFS=',' read -ra MODELS <<< "${MODEL_FILTERS}"
else
  MODELS=("")
fi

COMBO=0
TOTAL=$(( ${#EFFORTS[@]} * ${#MODELS[@]} ))
echo ">>> ${TOTAL} combinations queued (${#MODELS[@]} model filter(s) × ${#EFFORTS[@]} effort levels, ${REPETITIONS} reps each)"

for model in "${MODELS[@]}"; do
  for effort in "${EFFORTS[@]}"; do
    COMBO=$((COMBO + 1))
    echo ""
    echo "============================================================"
    echo " [${COMBO}/${TOTAL}] Model: ${model:-all}  Effort: ${effort}  Reps: ${REPETITIONS}"
    echo "============================================================"

    START_TIME=$(date +%s)

    CMD_ARGS=(--repetitions "${REPETITIONS}")
    if [ -n "${model}" ]; then
      CMD_ARGS+=(--model "${model}")
    fi
    if [ "${effort}" != "default" ]; then
      CMD_ARGS+=(--effort "${effort}")
    fi
    if [ -n "${PROMPT_VARIANT}" ]; then
      CMD_ARGS+=(--prompt "${PROMPT_VARIANT}")
    elif [ "${HARDENED}" = "true" ]; then
      CMD_ARGS+=(--hardened)
    fi
    if [ "${B6}" = "true" ]; then
      CMD_ARGS+=(--b6)
    fi

    npx tsx src/tests/test-adversarial-judge.ts "${CMD_ARGS[@]}" || {
      echo "  FAILED: model=${model:-all} effort=${effort}"
      continue
    }

    END_TIME=$(date +%s)
    ELAPSED=$((END_TIME - START_TIME))
    echo "  [${COMBO}/${TOTAL}] DONE in ${ELAPSED}s"

    # Upload results after each combo
    echo "  Uploading results to S3..."
    aws s3 sync results/ "s3://${S3_BUCKET}/${S3_PREFIX}/" \
      --exclude "*" --include "adversarial-judge-*" \
      --region "${AWS_REGION:-eu-west-2}" 2>/dev/null \
      && echo "  S3 sync OK" \
      || echo "  WARN: S3 sync failed"
  done
done

# ── Final upload ───────────────────────────────────────────────────────────
echo ""
echo "Final S3 sync..."
aws s3 sync results/ "s3://${S3_BUCKET}/${S3_PREFIX}/" \
  --exclude "*" --include "adversarial-judge-*" --include "test8.log" \
  --region "${AWS_REGION:-eu-west-2}" 2>/dev/null \
  && echo "S3 final sync OK" \
  || echo "WARN: S3 final sync failed"

# Upload log
aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test8.log" \
  --region "${AWS_REGION:-eu-west-2}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 8 complete"
echo "============================================================"
