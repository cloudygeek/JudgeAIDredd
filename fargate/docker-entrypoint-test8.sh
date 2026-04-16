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
#   TEST8_EFFORT  effort levels (default: none,medium,high)
#   S3_BUCKET       results bucket (default: judge-ai-dredd-results)
#   S3_PREFIX       results prefix (default: test8)
# ============================================================================

LOG_FILE="/app/results/test8.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test8}"
EFFORT_LEVELS="${TEST8_EFFORT:-default,low,medium,high,max}"

echo "============================================================"
echo " Test 8: Adversarial Judge Robustness"
echo " Effort levels: ${EFFORT_LEVELS}"
echo " S3: s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "============================================================"

# ── Preflight ──────────────────────────────────────────────────────────────
echo "Preflight: checking Bedrock access..."
aws bedrock-runtime converse \
  --region "${AWS_REGION:-eu-central-1}" \
  --model-id "eu.anthropic.claude-haiku-4-5-20251001-v1:0" \
  --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
  --inference-config '{"maxTokens":1}' \
  --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
  && echo "  Bedrock OK" \
  || { echo "  WARN: Bedrock preflight failed, continuing anyway"; }

echo "Preflight: checking S3 access (bucket: ${S3_BUCKET})..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${AWS_REGION:-eu-central-1}" --page-size 1 >/dev/null 2>&1 \
  && echo "  S3 list OK" \
  || { echo "  FATAL: Cannot list S3 bucket s3://${S3_BUCKET}/. Aborting."; exit 1; }

S3_TEST_KEY="${S3_PREFIX}/.preflight-$(date +%s)"
echo "preflight" | aws s3 cp - "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${AWS_REGION:-eu-central-1}" 2>/dev/null \
  && echo "  S3 write OK" \
  || { echo "  FATAL: Cannot write to S3 bucket. Aborting."; exit 1; }
aws s3 rm "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${AWS_REGION:-eu-central-1}" 2>/dev/null || true

# ── Run ────────────────────────────────────────────────────────────────────
IFS=',' read -ra EFFORTS <<< "${EFFORT_LEVELS}"

COMBO=0
TOTAL=${#EFFORTS[@]}
echo ">>> ${TOTAL} effort levels queued"

for effort in "${EFFORTS[@]}"; do
  COMBO=$((COMBO + 1))
  echo ""
  echo "============================================================"
  echo " [${COMBO}/${TOTAL}] Effort: ${effort}"
  echo "============================================================"

  START_TIME=$(date +%s)

  EFFORT_FLAG=""
  if [ "${effort}" != "default" ]; then
    EFFORT_FLAG="--effort ${effort}"
  fi

  npx tsx src/test-adversarial-judge.ts ${EFFORT_FLAG} || {
    echo "  FAILED: effort=${effort}"
    continue
  }

  END_TIME=$(date +%s)
  ELAPSED=$((END_TIME - START_TIME))
  echo "  [${COMBO}/${TOTAL}] DONE in ${ELAPSED}s"

  # Upload results
  echo "  Uploading results to S3..."
  aws s3 sync results/ "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --exclude "*" --include "adversarial-judge-*" \
    --region "${AWS_REGION:-eu-central-1}" 2>/dev/null \
    && echo "  S3 sync OK" \
    || echo "  WARN: S3 sync failed"
done

# ── Final upload ───────────────────────────────────────────────────────────
echo ""
echo "Final S3 sync..."
aws s3 sync results/ "s3://${S3_BUCKET}/${S3_PREFIX}/" \
  --exclude "*" --include "adversarial-judge-*" --include "test8.log" \
  --region "${AWS_REGION:-eu-central-1}" 2>/dev/null \
  && echo "S3 final sync OK" \
  || echo "WARN: S3 final sync failed"

# Upload log
aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test8.log" \
  --region "${AWS_REGION:-eu-central-1}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 8 complete"
echo "============================================================"
