#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 26 — Cross-Judge Sensitivity Analysis (dual-grade with GPT-4o-mini)
#
# Selects 50 trajectories from T3e + MT-AgentRisk defended runs, reconstructs
# the judge inputs, dual-grades with GPT-4o-mini, and computes Cohen's κ.
#
# Requires OPENAI_API_KEY in the environment (or as a container secret).
#
# Env overrides:
#   OPENAI_API_KEY      Required — OpenAI API key for GPT-4o-mini
#   TEST26_SAMPLE_SIZE  Number of trajectories (default: 50)
#   TEST26_SEED         Random seed (default: 2604)
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           Results prefix (default: test26)
# ============================================================================

# ── Identity ──────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Config ────────────────────────────────────────────────────────────────
SAMPLE_SIZE="${TEST26_SAMPLE_SIZE:-50}"
SEED="${TEST26_SEED:-2604}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test26}"
S3_REGION="${S3_REGION:-eu-west-1}"

RUN_ID="${TEST26_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTPUT_DIR="results/test26-${RUN_ID}"
LOG_FILE="results/test26-run-${RUN_ID}.log"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "════════════════════════════════════════════════════════════════════════"
echo " Test 26: Cross-Judge Sensitivity Analysis"
echo "════════════════════════════════════════════════════════════════════════"
echo " RUN_ID       : ${RUN_ID}"
echo " SAMPLE_SIZE  : ${SAMPLE_SIZE}"
echo " SEED         : ${SEED}"
echo " S3           : s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight — OpenAI API key ────────────────────────────────────────────
if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "FATAL: OPENAI_API_KEY not set"
    exit 1
fi
echo ">>> OpenAI API key present (${#OPENAI_API_KEY} chars)"

# ── Preflight — S3 access ────────────────────────────────────────────────
echo ""
echo ">>> S3 preflight check..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${S3_REGION}" --page-size 1 >/dev/null 2>&1 \
    && echo "    S3 OK" \
    || { echo "FATAL: Cannot list S3 bucket"; exit 1; }

# ── Preflight — Check result files exist ─────────────────────────────────
echo ""
echo ">>> Checking for T3e and MT-AgentRisk result files..."

# Pull down result files from S3 if not already present locally
# Test 26 needs results from tests 18/23 (T3e) and test24 (MT-AgentRisk)
# S3 prefixes: test18/, test23/, test24/
# Local paths: results/test18-t19/, results/test23-s3/, results/test24/
# (script searches results/**/t3e-*.json recursively)
declare -A S3_MAP=( ["test18"]="results/test18-t19" ["test23"]="results/test23-s3" ["test24"]="results/test24" )
for s3prefix in test18 test23 test24; do
    local_dir="${S3_MAP[$s3prefix]}"
    if [ ! -d "${local_dir}" ]; then
        echo "  Pulling s3://${S3_BUCKET}/${s3prefix}/ → ${local_dir}/..."
        aws s3 sync "s3://${S3_BUCKET}/${s3prefix}/" "${local_dir}/" \
            --region "${S3_REGION}" 2>/dev/null || true
    else
        echo "  ${local_dir} already present"
    fi
done

T3E_COUNT=$(find results/ -name "t3e-*-intent-tracker-*.json" 2>/dev/null | wc -l | tr -d ' ')
MTA_COUNT=$(find results/test24/ -name "t24-*.json" 2>/dev/null | wc -l | tr -d ' ')
echo "  T3e result files: ${T3E_COUNT}"
echo "  MT-AgentRisk result files: ${MTA_COUNT}"

if [ "${T3E_COUNT}" -eq 0 ] && [ "${MTA_COUNT}" -eq 0 ]; then
    echo "FATAL: No result files found for sampling"
    exit 1
fi

# ── Run cross-judge dual-grade ───────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Running cross-judge dual-grade"
echo "════════════════════════════════════════════════════════════════════════"

python3 scripts/cross-judge-dual-grade.py \
    --sample-size "${SAMPLE_SIZE}" \
    --seed "${SEED}" \
    --output-dir "${OUTPUT_DIR}" \
    || echo "WARN: dual-grade script exited with error"

# ── Upload results ────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Uploading results → s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}/"
echo "════════════════════════════════════════════════════════════════════════"

aws s3 sync "${OUTPUT_DIR}/" "s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}/" \
    --region "${S3_REGION}" \
    && echo "    Results uploaded" \
    || echo "WARNING: S3 sync failed"

aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}/$(basename "${LOG_FILE}")" \
    --region "${S3_REGION}" 2>/dev/null || true

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Test 26 complete — ${RUN_ID}"
echo "════════════════════════════════════════════════════════════════════════"
