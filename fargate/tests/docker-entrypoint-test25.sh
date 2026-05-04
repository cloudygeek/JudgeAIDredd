#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 25 — AgentLAB Long-Horizon Cross-Vendor Smoke
#
# Runs stratified AgentLAB scenarios (2 per attack type × 5 types = 10/cell)
# against Bedrock agents with and without the dredd defence.
#
# Env overrides:
#   TEST25_MODELS       CSV of model short names or Bedrock IDs
#                       (default: claude-sonnet-4-6)
#   TEST25_BACKEND      auto | sdk | converse (default: auto)
#   TEST25_DEFENCES     CSV of defences (default: none,intent-tracker)
#   TEST25_SCENARIOS    Sampling mode (default: stratified-10)
#   TEST25_ATTACK_TYPES CSV of attack types
#   TEST25_SEED         Random seed for stratified sampling (default: 27)
#   TEST25_MAX_TURNS    Max turns per trajectory (default: 8)
#   AGENT_REGION        Bedrock region for agent models (default: eu-west-1)
#   JUDGE_REGION        Bedrock region for judges (default: eu-central-1)
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           Results prefix (default: test25)
#   AGENTLAB_PATH       Path to AgentLAB clone (default: /opt/agentlab)
# ============================================================================

# ── Identity ──────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Config ────────────────────────────────────────────────────────────────
MODELS="${TEST25_MODELS:-claude-sonnet-4-6}"
BACKEND="${TEST25_BACKEND:-auto}"
DEFENCES="${TEST25_DEFENCES:-none,intent-tracker}"
SCENARIOS="${TEST25_SCENARIOS:-stratified-10}"
ATTACK_TYPES="${TEST25_ATTACK_TYPES:-intent_hijacking,tool_chaining,task_injection,objective_drifting,memory_poisoning}"
SEED="${TEST25_SEED:-27}"
MAX_TURNS="${TEST25_MAX_TURNS:-8}"
AGENT_REGION="${AGENT_REGION:-eu-west-1}"
JUDGE_REGION="${JUDGE_REGION:-eu-central-1}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test25}"
S3_REGION="${S3_REGION:-eu-west-1}"
AGENTLAB_PATH="${AGENTLAB_PATH:-/opt/agentlab}"

JUDGE_MODEL="eu.anthropic.claude-sonnet-4-6"
EMBED_MODEL="eu.cohere.embed-v4:0"
JUDGE_PROMPT="B7.1"

RUN_ID="${TEST25_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTPUT_DIR="results/test25-${RUN_ID}"
LOG_FILE="results/test25-run-${RUN_ID}.log"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "════════════════════════════════════════════════════════════════════════"
echo " Test 25: AgentLAB Long-Horizon Cross-Vendor Smoke"
echo "════════════════════════════════════════════════════════════════════════"
echo " RUN_ID        : ${RUN_ID}"
echo " MODELS        : ${MODELS}"
echo " BACKEND       : ${BACKEND}"
echo " DEFENCES      : ${DEFENCES}"
echo " SCENARIOS     : ${SCENARIOS}"
echo " ATTACK_TYPES  : ${ATTACK_TYPES}"
echo " SEED          : ${SEED}"
echo " MAX_TURNS     : ${MAX_TURNS}"
echo " AGENT_REGION  : ${AGENT_REGION}"
echo " JUDGE         : ${JUDGE_MODEL}"
echo " JUDGE_PROMPT  : ${JUDGE_PROMPT}"
echo " JUDGE_REGION  : ${JUDGE_REGION}"
echo " EMBED         : ${EMBED_MODEL}"
echo " AGENTLAB_PATH : ${AGENTLAB_PATH}"
echo " S3            : s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight — Agent model access ──────────────────────────────────────
echo ""
echo ">>> Bedrock preflight: agent model access..."

# Anthropic model map
declare -A ANTHROPIC_MAP=(
    [claude-haiku-4-5]="eu.anthropic.claude-haiku-4-5-20251001-v1:0"
    [claude-sonnet-4-6]="eu.anthropic.claude-sonnet-4-6"
    [claude-opus-4-6]="eu.anthropic.claude-opus-4-6-v1"
    [claude-opus-4-7]="eu.anthropic.claude-opus-4-7"
)

# Qwen model map
declare -A QWEN_MAP=(
    [qwen3-32b]="qwen.qwen3-32b-v1:0"
    [qwen3-235b]="qwen.qwen3-235b-a22b-2507-v1:0"
    [qwen3-coder-30b]="qwen.qwen3-coder-30b-a3b-v1:0"
)

IFS=',' read -ra MODEL_ARRAY <<< "${MODELS}"
for m in "${MODEL_ARRAY[@]}"; do
    m=$(echo "${m}" | xargs)  # trim whitespace
    # Resolve model ID
    MID="${ANTHROPIC_MAP[${m}]:-}"
    REGION="${AGENT_REGION}"
    if [ -z "${MID}" ]; then
        MID="${QWEN_MAP[${m}]:-${m}}"
        # Qwen models may be in a different region
        if [[ "${MID}" == qwen.* ]]; then
            REGION="${AGENT_REGION}"
        fi
    fi

    echo "  Testing ${m} → ${MID} in ${REGION}..."
    aws bedrock-runtime converse \
        --region "${REGION}" \
        --model-id "${MID}" \
        --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
        --inference-config '{"maxTokens":1}' \
        --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
        && echo "    OK: ${MID}" \
        || { echo "FATAL: model ${MID} not accessible in ${REGION}"; exit 1; }
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

# ── AgentLAB commit hash ───────────────────────────────────────────────
AGENTLAB_COMMIT="unknown"
if [ -d "${AGENTLAB_PATH}/.git" ]; then
    AGENTLAB_COMMIT=$(git -C "${AGENTLAB_PATH}" rev-parse HEAD 2>/dev/null || echo "unknown")
fi
echo ""
echo "  AgentLAB commit: ${AGENTLAB_COMMIT}"

# ── Run AgentLAB benchmark ──────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Starting AgentLAB runner"
echo "════════════════════════════════════════════════════════════════════════"

export AGENT_REGION
export JUDGE_BEDROCK_REGION="${JUDGE_REGION}"
export AWS_REGION="${JUDGE_REGION}"

npx tsx src/tests/runner-agentlab.ts \
    --models "${MODELS}" \
    --backend "${BACKEND}" \
    --scenarios "${SCENARIOS}" \
    --attack-types "${ATTACK_TYPES}" \
    --random-seed "${SEED}" \
    --defences "${DEFENCES}" \
    --max-turns "${MAX_TURNS}" \
    --benchmark-judge-model "${JUDGE_MODEL}" \
    --benchmark-judge-temperature 0 \
    --dredd-judge-model "${JUDGE_MODEL}" \
    --dredd-judge-prompt "${JUDGE_PROMPT}" \
    --embed-model "${EMBED_MODEL}" \
    --agent-region "${AGENT_REGION}" \
    --agentlab-commit "${AGENTLAB_COMMIT}" \
    --agentlab-path "${AGENTLAB_PATH}" \
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
echo " Test 25 complete — ${RUN_ID}"
echo "════════════════════════════════════════════════════════════════════════"
