#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 16 — Cross-Model Re-run Under the Recommended Pipeline
#
# Re-runs the §6.9 cross-model matrix with:
#   - Cohere Embed v4 (instead of Titan Embed V2)
#   - Prompt v2 / B7.1 (instead of baseline)
#   - PreToolUse interception via intent-tracker
#
# Iterates 4 agent models × 3 scenarios × 2 defences × N reps.
#
# Env overrides:
#   TEST16_MODELS     CSV of agent models (default: all 4)
#   TEST16_SCENARIOS  CSV of scenarios (default: intermediate,sophisticated)
#   TEST16_DEFENCES   CSV of defences (default: none,intent-tracker)
#   TEST16_REPS       Reps per cell (default: 20)
#   S3_BUCKET         Results bucket (default: cko-results)
#   S3_PREFIX         Results prefix (default: test16)
#   AWS_REGION        Bedrock region (default: eu-west-2)
# ============================================================================

# ── Identity ──────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Claude Code SDK prerequisites ─────────────────────────────────────────
export HOME="${HOME:-/tmp/claude-home}"
mkdir -p "${HOME}/.claude"

# ── Config ────────────────────────────────────────────────────────────────
MODELS="${TEST16_MODELS:-claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-6,claude-opus-4-7}"
SCENARIOS="${TEST16_SCENARIOS:-intermediate,sophisticated}"
DEFENCES="${TEST16_DEFENCES:-none,intent-tracker}"
REPS="${TEST16_REPS:-20}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test16}"
S3_REGION="${S3_REGION:-eu-west-1}"
AWS_REGION="${AWS_REGION:-eu-west-2}"
RUN_ID="${TEST16_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

# Recommended pipeline config (paper §S.1)
EMBEDDING_MODEL="eu.cohere.embed-v4:0"
JUDGE_MODEL="eu.anthropic.claude-haiku-4-5-20251001-v1:0"
HARDENED="B7.1"

S3_BASE="s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}"
LOG_FILE="results/run-${RUN_ID}.log"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "════════════════════════════════════════════════════════════════════════"
echo " Test 16: Cross-Model — Recommended Pipeline"
echo "════════════════════════════════════════════════════════════════════════"
echo " RUN_ID       : ${RUN_ID}"
echo " MODELS       : ${MODELS}"
echo " SCENARIOS    : ${SCENARIOS}"
echo " DEFENCES     : ${DEFENCES}"
echo " REPS         : ${REPS}"
echo " EMBED        : ${EMBEDDING_MODEL}"
echo " JUDGE        : ${JUDGE_MODEL}"
echo " PROMPT       : ${HARDENED}"
echo " BEDROCK      : ${AWS_REGION}"
echo " S3           : ${S3_BASE}/"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight ─────────────────────────────────────────────────────────────
echo ""
echo ">>> Bedrock preflight check (region: ${AWS_REGION})..."

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

S3_TEST_KEY="${S3_PREFIX}/.preflight-${RUN_ID}"
echo "preflight" | aws s3 cp - "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null \
    && echo "    S3 write OK" \
    || { echo "ERROR: Cannot write to S3"; exit 1; }
aws s3 rm "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null || true

# ── Run combinations ──────────────────────────────────────────────────────
IFS=',' read -ra MODEL_LIST    <<< "${MODELS}"
IFS=',' read -ra SCENARIO_LIST <<< "${SCENARIOS}"
IFS=',' read -ra DEFENCE_LIST  <<< "${DEFENCES}"

TOTAL=$(( ${#MODEL_LIST[@]} * ${#SCENARIO_LIST[@]} * ${#DEFENCE_LIST[@]} ))
COUNT=0
FAILED=0

for model in "${MODEL_LIST[@]}"; do
    # Per-model effort: medium for Opus, none for Haiku/Sonnet
    EFFORT=""
    if [[ "${model}" == *opus* ]]; then
        EFFORT="medium"
    fi

    for scenario in "${SCENARIO_LIST[@]}"; do
        for defence in "${DEFENCE_LIST[@]}"; do
            COUNT=$(( COUNT + 1 ))
            TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
            OUTPUT_FILE="results/cross-model-${model}-${defence}-${scenario}-${TIMESTAMP}.json"

            echo ""
            echo "──────────────────────────────────────────────────────────────────────"
            echo " [${COUNT}/${TOTAL}] model=${model}  scenario=${scenario}  defence=${defence}"
            echo "   effort=${EFFORT:-default}  prompt=${HARDENED}  embed=${EMBEDDING_MODEL}"
            echo "   output: ${OUTPUT_FILE}"
            echo "──────────────────────────────────────────────────────────────────────"

            RUN_START=$(date -u +%s)

            EFFORT_ARGS=()
            if [ -n "${EFFORT}" ]; then
                EFFORT_ARGS+=(--effort "${EFFORT}")
            fi

            HARDENED_ARGS=()
            if [ "${defence}" != "none" ]; then
                HARDENED_ARGS+=(--hardened "${HARDENED}")
            fi

            if npx tsx src/runner-bedrock.ts \
                --model        "${model}" \
                --scenario     "${scenario}" \
                --defence      "${defence}" \
                --repetitions  "${REPS}" \
                --embedding-backend bedrock \
                --judge-backend     bedrock \
                --embedding-model   "${EMBEDDING_MODEL}" \
                --judge-model       "${JUDGE_MODEL}" \
                "${EFFORT_ARGS[@]}" \
                "${HARDENED_ARGS[@]}" \
                --batch \
                --fail-fast \
                --output "${OUTPUT_FILE}"; then

                RUN_END=$(date -u +%s)
                echo "Completed in $(( RUN_END - RUN_START ))s"
            else
                FAILED=$(( FAILED + 1 ))
                echo "WARNING: run failed (model=${model} scenario=${scenario} defence=${defence}) — continuing"
            fi

            # Upload immediately
            if [ -f "${OUTPUT_FILE}" ]; then
                aws s3 cp "${OUTPUT_FILE}" \
                    "${S3_BASE}/$(basename "${OUTPUT_FILE}")" \
                    --region "${S3_REGION}" \
                    && echo "Uploaded: ${S3_BASE}/$(basename "${OUTPUT_FILE}")" \
                    || echo "WARNING: S3 upload failed for ${OUTPUT_FILE}"
            fi

            # Upload log after each combination
            if [ -f "${LOG_FILE}" ]; then
                aws s3 cp "${LOG_FILE}" \
                    "${S3_BASE}/$(basename "${LOG_FILE}")" \
                    --region "${S3_REGION}" 2>/dev/null || true
            fi
        done
    done
done

# ── Final sync ────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Final sync: results/ → ${S3_BASE}/"
echo "════════════════════════════════════════════════════════════════════════"
aws s3 sync results/ "${S3_BASE}/" --region "${S3_REGION}"

echo ""
echo " Done. ${COUNT} combinations run, ${FAILED} failed."
echo " Results: ${S3_BASE}/"
echo "════════════════════════════════════════════════════════════════════════"

[ "${FAILED}" -eq 0 ] || exit 1
