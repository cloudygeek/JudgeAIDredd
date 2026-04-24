#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 15 — False-Positive Rate under Prompt v2 (B7.1)
#
# Runs 10 legitimate developer tasks through the full defence pipeline
# with the B7.1 hardened prompt and measures false positive rate.
#
# Env overrides:
#   TEST15_PROMPT       Judge prompt variant (default: B7.1)
#   TEST15_TASK         Single task filter, e.g. "L7" (default: all)
#   TEST15_REPS         Reps per task (default: 10)
#   TEST15_MODEL        Agent model (default: claude-sonnet-4-6)
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           Results prefix (default: test15)
#   AWS_REGION          Bedrock region (default: eu-west-2)
# ============================================================================

PROMPT="${TEST15_PROMPT:-B7.1}"
TASK="${TEST15_TASK:-all}"
REPS="${TEST15_REPS:-10}"
MODEL="${TEST15_MODEL:-claude-sonnet-4-6}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test15}"
S3_REGION="${S3_REGION:-eu-west-1}"
AWS_REGION="${AWS_REGION:-eu-west-2}"
RUN_ID="${TEST15_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

LOG_FILE="results/test15-${RUN_ID}.log"
RESULTS_DIR="results/fpr-${PROMPT}-${RUN_ID}"
S3_BASE="s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}"

exec > >(tee -a "${LOG_FILE}") 2>&1

# ── Claude Code SDK prerequisites ─────────────────────────────────────────
export HOME="${HOME:-/tmp/claude-home}"
mkdir -p "${HOME}/.claude"

# ── Identity ──────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

echo "============================================================"
echo " Test 15: FPR under Prompt ${PROMPT}"
echo "============================================================"
echo " Prompt:    ${PROMPT}"
echo " Task:      ${TASK}"
echo " Reps:      ${REPS}"
echo " Model:     ${MODEL}"
echo " Region:    ${AWS_REGION}"
echo " S3:        ${S3_BASE}/"
echo " Run ID:    ${RUN_ID}"
echo "============================================================"

# ── Preflight ──────────────────────────────────────────────────────────────
echo ""
echo ">>> Bedrock preflight check (region: ${AWS_REGION})..."

EMBEDDING_MODEL="amazon.titan-embed-text-v2:0"
JUDGE_MODEL="eu.anthropic.claude-haiku-4-5-20251001-v1:0"

EMBED_BODY=$(echo -n '{"inputText":"preflight"}' | base64)
aws bedrock-runtime invoke-model \
    --region "${AWS_REGION}" \
    --model-id "${EMBEDDING_MODEL}" \
    --content-type "application/json" \
    --accept "application/json" \
    --body "${EMBED_BODY}" \
    /dev/stdout 2>&1 >/dev/null \
    && echo "    Embedding model OK: ${EMBEDDING_MODEL}" \
    || { echo "ERROR: Embedding model not accessible"; exit 1; }

aws bedrock-runtime converse \
    --region "${AWS_REGION}" \
    --model-id "${JUDGE_MODEL}" \
    --messages '[{"role":"user","content":[{"text":"say ok"}]}]' \
    --inference-config '{"maxTokens":1}' \
    --output text \
    --query "output.message.content[0].text" 2>&1 >/dev/null \
    && echo "    Judge model OK: ${JUDGE_MODEL}" \
    || { echo "ERROR: Judge model not accessible"; exit 1; }

echo ""
echo ">>> S3 preflight check..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${S3_REGION}" --page-size 1 >/dev/null 2>&1 \
    && echo "    S3 OK" \
    || { echo "ERROR: Cannot list S3 bucket"; exit 1; }

# ── Smoke gate (L7 at N=3 if running all tasks) ──────────────────────────
if [ "${TASK}" = "all" ]; then
    echo ""
    echo ">>> Smoke gate: L7 (Secrets Manager migration) at N=3..."
    mkdir -p "${RESULTS_DIR}"
    if npx tsx src/test-fpr.ts \
        --task L7 \
        --repetitions 3 \
        --model "${MODEL}" \
        --prompt "${PROMPT}" \
        --output "${RESULTS_DIR}"; then
        echo "    Smoke gate PASSED — proceeding with full matrix"
    else
        echo "    Smoke gate FAILED — L7 has false positives under ${PROMPT}"
        echo "    Uploading partial results and exiting"
        aws s3 sync "${RESULTS_DIR}/" "${S3_BASE}/" --region "${S3_REGION}" 2>/dev/null || true
        aws s3 cp "${LOG_FILE}" "${S3_BASE}/$(basename "${LOG_FILE}")" --region "${S3_REGION}" 2>/dev/null || true
        exit 1
    fi
fi

# ── Full matrix ───────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo " Running FPR matrix: ${TASK} × ${REPS} reps (prompt: ${PROMPT})"
echo "============================================================"

TASK_ARGS=()
if [ "${TASK}" != "all" ]; then
    TASK_ARGS+=(--task "${TASK}")
fi

if npx tsx src/test-fpr.ts \
    "${TASK_ARGS[@]}" \
    --repetitions "${REPS}" \
    --model "${MODEL}" \
    --prompt "${PROMPT}" \
    --output "${RESULTS_DIR}"; then
    echo ""
    echo ">>> FPR run completed successfully"
else
    echo ""
    echo ">>> FPR run completed with failures"
fi

# ── Upload results ────────────────────────────────────────────────────────
echo ""
echo ">>> Uploading results to ${S3_BASE}/..."
aws s3 sync "${RESULTS_DIR}/" "${S3_BASE}/" --region "${S3_REGION}" 2>/dev/null || true
aws s3 cp "${LOG_FILE}" "${S3_BASE}/$(basename "${LOG_FILE}")" --region "${S3_REGION}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 15 complete"
echo " Results: ${S3_BASE}/"
echo "============================================================"
