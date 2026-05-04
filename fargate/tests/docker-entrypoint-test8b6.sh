#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 8 B6 — Format Leakage (same semantic action, different surface format)
#
# Runs 32 format-variant cases (8 base cases × 4 formats) × N models.
# Tests whether the judge keys on surface formatting vs semantic content.
#
# Env overrides:
#   TEST8B6_MODELS   comma-separated model filters (default: Sonnet 4.6 only)
#   TEST8B6_EFFORT   effort levels (default: default)
#   TEST8B6_REPS     repetitions per case (default: 5)
#   S3_BUCKET        results bucket
#   S3_PREFIX        results prefix (default: test8-b6)
# ============================================================================

LOG_FILE="/app/results/test8-b6.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test8-b6}"
EFFORT_LEVELS="${TEST8B6_EFFORT:-default}"
REPETITIONS="${TEST8B6_REPS:-5}"
MODEL_FILTERS="${TEST8B6_MODELS:-Claude Sonnet 4.6}"

echo "============================================================"
echo " Test 8 B6: Format Leakage"
echo " Effort levels: ${EFFORT_LEVELS}"
echo " Repetitions:   ${REPETITIONS}"
echo " Models:        ${MODEL_FILTERS}"
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
IFS=',' read -ra MODELS <<< "${MODEL_FILTERS}"

COMBO=0
TOTAL=$(( ${#EFFORTS[@]} * ${#MODELS[@]} ))
echo ">>> ${TOTAL} combinations queued (${#MODELS[@]} model(s) × ${#EFFORTS[@]} effort levels, ${REPETITIONS} reps each, 32 B6 format-variant cases)"

for model in "${MODELS[@]}"; do
  for effort in "${EFFORTS[@]}"; do
    COMBO=$((COMBO + 1))
    echo ""
    echo "============================================================"
    echo " [${COMBO}/${TOTAL}] Model: ${model}  Effort: ${effort}  Reps: ${REPETITIONS}"
    echo "============================================================"

    START_TIME=$(date +%s)

    CMD_ARGS=(--repetitions "${REPETITIONS}" --b6 --hardened --model "${model}")
    if [ "${effort}" != "default" ]; then
      CMD_ARGS+=(--effort "${effort}")
    fi

    npx tsx src/test-adversarial-judge.ts "${CMD_ARGS[@]}" || {
      echo "  FAILED: model=${model} effort=${effort}"
      continue
    }

    END_TIME=$(date +%s)
    ELAPSED=$((END_TIME - START_TIME))
    echo "  [${COMBO}/${TOTAL}] DONE in ${ELAPSED}s"

    # Upload results after each combo
    echo "  Uploading results to S3..."
    aws s3 sync results/ "s3://${S3_BUCKET}/${S3_PREFIX}/" \
      --exclude "*" --include "adversarial-judge-*-B6-*" \
      --region "${AWS_REGION:-eu-west-2}" 2>/dev/null \
      && echo "  S3 sync OK" \
      || echo "  WARN: S3 sync failed"
  done
done

# ── Final upload ───────────────────────────────────────────────────────────
echo ""
echo "Final S3 sync..."
aws s3 sync results/ "s3://${S3_BUCKET}/${S3_PREFIX}/" \
  --exclude "*" --include "adversarial-judge-*-B6-*" --include "test8-b6.log" \
  --region "${AWS_REGION:-eu-west-2}" 2>/dev/null \
  && echo "S3 final sync OK" \
  || echo "WARN: S3 final sync failed"

aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test8-b6.log" \
  --region "${AWS_REGION:-eu-west-2}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 8 B6 complete"
echo "============================================================"
