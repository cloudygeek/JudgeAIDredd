#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 27 — Qwen3 235B A22B on P14 T4 + T5 (Peer-Review M4)
#
# Runs T4 (HTTP injection) and T5 (multi-stage file attack) with Qwen3 235B
# through the 4-arm defence matrix via the Bedrock Converse API.
#
# Env overrides:
#   TEST27_MODELS       Agent model (default: qwen3-235b)
#   TEST27_TECHNIQUES   CSV of techniques (default: T4,T5)
#   TEST27_DEFENCES     CSV of arms (default: C4-baseline,C4-judge,C1-baseline,C1-judge)
#   TEST27_REPS         Reps per cell (default: 25)
#   TEST27_MAX_TURNS    Max turns per scenario (default: 10)
#   JUDGE_REGION        Bedrock region for judge + embedding (default: eu-central-1)
#   AWS_REGION          Default region (default: eu-central-1)
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           Results prefix (default: test27)
# ============================================================================

# ── Identity ──────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Config ────────────────────────────────────────────────────────────────
MODELS="${TEST27_MODELS:-qwen3-235b}"
TECHNIQUES="${TEST27_TECHNIQUES:-T4,T5}"
DEFENCES="${TEST27_DEFENCES:-C4-baseline,C4-judge,C1-baseline,C1-judge}"
REPS="${TEST27_REPS:-25}"
MAX_TURNS="${TEST27_MAX_TURNS:-10}"
JUDGE_REGION="${JUDGE_REGION:-eu-central-1}"
AWS_REGION="${AWS_REGION:-eu-central-1}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test27}"
S3_REGION="${S3_REGION:-eu-west-1}"

JUDGE_MODEL="eu.anthropic.claude-sonnet-4-6"
EMBED_MODEL="eu.cohere.embed-v4:0"
JUDGE_PROMPT="B7.1"

RUN_ID="${TEST27_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTPUT_DIR="results/test27-${RUN_ID}"
LOG_FILE="results/test27-run-${RUN_ID}.log"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "════════════════════════════════════════════════════════════════════════"
echo " Test 27: Qwen3 235B on T4 + T5 (Peer-Review M4)"
echo "════════════════════════════════════════════════════════════════════════"
echo " RUN_ID       : ${RUN_ID}"
echo " MODELS       : ${MODELS}"
echo " TECHNIQUES   : ${TECHNIQUES}"
echo " DEFENCES     : ${DEFENCES}"
echo " REPS         : ${REPS}"
echo " MAX_TURNS    : ${MAX_TURNS}"
echo " JUDGE        : ${JUDGE_MODEL}"
echo " JUDGE_PROMPT : ${JUDGE_PROMPT}"
echo " JUDGE_REGION : ${JUDGE_REGION}"
echo " EMBED        : ${EMBED_MODEL}"
echo " AGENT_BACKEND: converse"
echo " S3           : s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight — Agent model access (Converse API) ────────────────────────
echo ""
echo ">>> Bedrock preflight: Qwen agent model via Converse API (region: ${AWS_REGION})..."

IFS=',' read -ra MODEL_ARRAY <<< "${MODELS}"
for m in "${MODEL_ARRAY[@]}"; do
    m=$(echo "${m}" | xargs)
    case "${m}" in
        qwen3-235b) MID="qwen.qwen3-235b-a22b-2507-v1:0" ;;
        qwen3-32b)  MID="qwen.qwen3-32b-v1:0" ;;
        qwen3-coder-30b) MID="qwen.qwen3-coder-30b-a3b-v1:0" ;;
        *) MID="${m}" ;;
    esac
    echo "  Testing ${m} → ${MID}..."
    aws bedrock-runtime converse \
        --region "${AWS_REGION}" \
        --model-id "${MID}" \
        --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
        --inference-config '{"maxTokens":1}' \
        --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
        && echo "    OK: ${MID}" \
        || { echo "FATAL: model ${MID} not accessible in ${AWS_REGION}"; exit 1; }
done

# ── Preflight — Judge model access ──────────────────────────────────────
echo ""
echo ">>> Bedrock preflight: judge model access (region: ${JUDGE_REGION})..."
aws bedrock-runtime converse \
    --region "${JUDGE_REGION}" \
    --model-id "${JUDGE_MODEL}" \
    --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
    --inference-config '{"maxTokens":1}' \
    --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
    && echo "    Judge model OK: ${JUDGE_MODEL}" \
    || { echo "FATAL: Judge model not accessible in ${JUDGE_REGION}"; exit 1; }

# ── Preflight — S3 access ──────────────────────────────────────────────
echo ""
echo ">>> S3 preflight check..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${S3_REGION}" --page-size 1 >/dev/null 2>&1 \
    && echo "    S3 OK" \
    || { echo "FATAL: Cannot list S3 bucket"; exit 1; }

S3_TEST_KEY="${S3_PREFIX}/.preflight-${RUN_ID}"
echo "preflight" | aws s3 cp - "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null \
    && echo "    S3 write OK" \
    || { echo "FATAL: Cannot write to S3"; exit 1; }
aws s3 rm "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null || true

# ── Run P14 cross-technique matrix (Converse backend) ─────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Starting P14 runner (--agent-backend converse)"
echo "════════════════════════════════════════════════════════════════════════"

export AWS_REGION="${JUDGE_REGION}"
export CLAUDE_CODE_USE_BEDROCK=1

npx tsx src/runner-p14.ts \
    --models "${MODELS}" \
    --techniques "${TECHNIQUES}" \
    --defences "${DEFENCES}" \
    --repetitions "${REPS}" \
    --max-turns "${MAX_TURNS}" \
    --judge-model "${JUDGE_MODEL}" \
    --judge-prompt "${JUDGE_PROMPT}" \
    --embed-model "${EMBED_MODEL}" \
    --agent-backend converse \
    --canary-port 3003 \
    --output-dir "${OUTPUT_DIR}" \
    || echo "WARN: runner exited with error"

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
echo " Test 27 complete — ${RUN_ID}"
echo "════════════════════════════════════════════════════════════════════════"
