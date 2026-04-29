#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 22 — P14 Cross-Technique Generalisation (T4 + T5 with Judge)
#
# Runs T4 (HTTP response injection / payload splitting) and T5 (multi-stage
# file attack) through the 4-arm defence matrix:
#   C4-baseline:  no system prompt, no judge
#   C4-judge:     no system prompt, judge active
#   C1-baseline:  system prompt + sandbox, no judge
#   C1-judge:     system prompt + sandbox + judge
#
# Env overrides:
#   TEST22_MODELS       CSV of agent models (default: claude-sonnet-4-6,claude-opus-4-7)
#   TEST22_TECHNIQUES   CSV of techniques: T4,T5 (default: T4,T5)
#   TEST22_DEFENCES     CSV of arms (default: C4-baseline,C4-judge,C1-baseline,C1-judge)
#   TEST22_REPS         Reps per cell (default: 20)
#   TEST22_MAX_TURNS    Max turns per scenario (default: 10)
#   JUDGE_REGION        Bedrock region for judge + embedding (default: eu-central-1)
#   AWS_REGION          Default region (default: eu-central-1)
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           Results prefix (default: test22)
#
# Container split examples (8 containers):
#   Container 1: TEST22_MODELS=claude-sonnet-4-6 TEST22_TECHNIQUES=T4
#   Container 2: TEST22_MODELS=claude-sonnet-4-6 TEST22_TECHNIQUES=T5
#   Container 3: TEST22_MODELS=claude-opus-4-7   TEST22_TECHNIQUES=T4
#   Container 4: TEST22_MODELS=claude-opus-4-7   TEST22_TECHNIQUES=T5
#   (each runs all 4 defence arms × all scenarios × 20 reps)
#
# Or 4 containers (technique split only):
#   Container 1: TEST22_TECHNIQUES=T4 (both models)
#   Container 2: TEST22_TECHNIQUES=T5 (both models)
#   Container 3: TEST22_TECHNIQUES=T4 TEST22_DEFENCES=C4-baseline,C4-judge
#   Container 4: TEST22_TECHNIQUES=T4 TEST22_DEFENCES=C1-baseline,C1-judge
# ============================================================================

# ── Identity ──────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Config ────────────────────────────────────────────────────────────────
MODELS="${TEST22_MODELS:-claude-sonnet-4-6,claude-opus-4-7}"
TECHNIQUES="${TEST22_TECHNIQUES:-T4,T5}"
DEFENCES="${TEST22_DEFENCES:-C4-baseline,C4-judge,C1-baseline,C1-judge}"
REPS="${TEST22_REPS:-20}"
MAX_TURNS="${TEST22_MAX_TURNS:-10}"
JUDGE_REGION="${JUDGE_REGION:-eu-central-1}"
AWS_REGION="${AWS_REGION:-eu-central-1}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test22}"
S3_REGION="${S3_REGION:-eu-west-1}"

JUDGE_MODEL="eu.anthropic.claude-sonnet-4-6"
EMBED_MODEL="eu.cohere.embed-v4:0"
JUDGE_PROMPT="B7.1"

RUN_ID="${TEST22_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTPUT_DIR="results/test22-${RUN_ID}"
LOG_FILE="results/test22-run-${RUN_ID}.log"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "════════════════════════════════════════════════════════════════════════"
echo " Test 22: P14 Cross-Technique Generalisation (T4 + T5)"
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
echo " S3           : s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight — Agent model access ──────────────────────────────────────
echo ""
echo ">>> Bedrock preflight: agent model access (region: ${AWS_REGION})..."

IFS=',' read -ra MODEL_ARRAY <<< "${MODELS}"
for m in "${MODEL_ARRAY[@]}"; do
    m=$(echo "${m}" | xargs)
    # Resolve friendly names to Bedrock model IDs
    case "${m}" in
        claude-sonnet-4-6) MID="eu.anthropic.claude-sonnet-4-6" ;;
        claude-opus-4-7)   MID="eu.anthropic.claude-opus-4-7" ;;
        claude-opus-4-6)   MID="eu.anthropic.claude-opus-4-6-v1" ;;
        claude-haiku-4-5)  MID="eu.anthropic.claude-haiku-4-5-20251001-v1:0" ;;
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

# ── Run P14 cross-technique matrix ─────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Starting P14 runner"
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
echo " Test 22 complete — ${RUN_ID}"
echo "════════════════════════════════════════════════════════════════════════"
