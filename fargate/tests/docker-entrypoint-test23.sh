#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 23 — T3e Cross-Vendor Exfiltration with Qwen3 (Bedrock Converse)
#
# Runs T3e scenarios against Qwen3 models via Bedrock Converse API.
# Uses the same T3e runner as Test 18 but with the converse backend instead
# of the Claude Code SDK.
#
# Env overrides:
#   TEST23_MODELS       CSV of Qwen model short names or Bedrock IDs
#                       (default: qwen3-32b,qwen3-235b,qwen3-coder-30b)
#   TEST23_SCENARIOS    CSV of T3e scenarios (default: T3e.2,T3e.3,T3e.4)
#   TEST23_DEFENCES     CSV of defences (default: none,intent-tracker)
#   TEST23_REPS         Reps per cell (default: 20)
#   TEST23_MAX_TURNS    Max turns per query (default: 10)
#   AGENT_REGION        Bedrock region for agent models (default: eu-central-1)
#   JUDGE_REGION        Bedrock region for Dredd judge (default: eu-central-1)
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           Results prefix (default: test23)
#   AWS_REGION          Default region (default: eu-central-1)
# ============================================================================

# ── Identity ──────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Config ────────────────────────────────────────────────────────────────
MODELS="${TEST23_MODELS:-qwen3-32b,qwen3-235b,qwen3-coder-30b}"
SCENARIOS="${TEST23_SCENARIOS:-T3e.2,T3e.3,T3e.4}"
DEFENCES="${TEST23_DEFENCES:-none,intent-tracker}"
REPS="${TEST23_REPS:-20}"
MAX_TURNS="${TEST23_MAX_TURNS:-10}"
AGENT_REGION="${AGENT_REGION:-eu-central-1}"
JUDGE_REGION="${JUDGE_REGION:-eu-central-1}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test23}"
S3_REGION="${S3_REGION:-eu-west-1}"
AWS_REGION="${AWS_REGION:-eu-central-1}"

JUDGE_MODEL="eu.anthropic.claude-sonnet-4-6"
EMBED_MODEL="eu.cohere.embed-v4:0"
JUDGE_PROMPT="B7.1"

RUN_ID="${TEST23_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTPUT_DIR="results/test23-${RUN_ID}"
LOG_FILE="results/test23-run-${RUN_ID}.log"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "════════════════════════════════════════════════════════════════════════"
echo " Test 23: T3e Cross-Vendor Exfiltration — Qwen3 (Bedrock Converse)"
echo "════════════════════════════════════════════════════════════════════════"
echo " RUN_ID       : ${RUN_ID}"
echo " MODELS       : ${MODELS}"
echo " SCENARIOS    : ${SCENARIOS}"
echo " DEFENCES     : ${DEFENCES}"
echo " REPS         : ${REPS}"
echo " MAX_TURNS    : ${MAX_TURNS}"
echo " AGENT_REGION : ${AGENT_REGION}"
echo " JUDGE        : ${JUDGE_MODEL}"
echo " JUDGE_PROMPT : ${JUDGE_PROMPT}"
echo " JUDGE_REGION : ${JUDGE_REGION}"
echo " EMBED        : ${EMBED_MODEL}"
echo " S3           : s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight — Agent model access ──────────────────────────────────────
echo ""
echo ">>> Bedrock preflight: agent model access (region: ${AGENT_REGION})..."

# Resolve model IDs for preflight
declare -A QWEN_MAP=(
    [qwen3-32b]="qwen.qwen3-32b-v1:0"
    [qwen3-235b]="qwen.qwen3-235b-a22b-2507-v1:0"
    [qwen3-coder-30b]="qwen.qwen3-coder-30b-a3b-v1:0"
    [qwen3-coder-480b]="qwen.qwen3-coder-480b-a35b-v1:0"
    [qwen3-coder-next]="qwen.qwen3-coder-next-v1:0"
)

IFS=',' read -ra MODEL_ARRAY <<< "${MODELS}"
for m in "${MODEL_ARRAY[@]}"; do
    m=$(echo "${m}" | xargs)  # trim whitespace
    MID="${QWEN_MAP[${m}]:-${m}}"
    echo "  Testing ${m} → ${MID} in ${AGENT_REGION}..."
    aws bedrock-runtime converse \
        --region "${AGENT_REGION}" \
        --model-id "${MID}" \
        --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
        --inference-config '{"maxTokens":1}' \
        --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
        && echo "    OK: ${MID}" \
        || { echo "FATAL: model ${MID} not accessible in ${AGENT_REGION}"; exit 1; }
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

# ── Run T3e with Converse backend ────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Starting T3e runner (converse backend)"
echo "════════════════════════════════════════════════════════════════════════"

export AGENT_REGION
export AWS_REGION="${JUDGE_REGION}"

npx tsx src/tests/runner-t3e-pretooluse.ts \
    --models "${MODELS}" \
    --scenarios "${SCENARIOS}" \
    --defences "${DEFENCES}" \
    --repetitions "${REPS}" \
    --max-turns "${MAX_TURNS}" \
    --judge-model "${JUDGE_MODEL}" \
    --judge-prompt "${JUDGE_PROMPT}" \
    --embed-model "${EMBED_MODEL}" \
    --canary-port 3003 \
    --output-dir "${OUTPUT_DIR}" \
    --agent-backend converse \
    --agent-region "${AGENT_REGION}" \
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
echo " Test 23 complete — ${RUN_ID}"
echo "════════════════════════════════════════════════════════════════════════"
