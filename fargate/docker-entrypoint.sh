#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Test 7 entrypoint: Cross-Model Agent Testing
#
# Runs every (model × scenario × defence) combination for Test 7 and uploads
# each result to S3 immediately after it completes, so progress is never lost.
#
# No ANTHROPIC_API_KEY required — agent runs via Bedrock (runner-bedrock.ts).
#
# Optional env vars (all have Test 7 defaults):
#   TEST7_MODELS    CSV of agent models  (default: claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-6)
#   TEST7_SCENARIOS CSV of scenarios     (default: intermediate,sophisticated)
#   TEST7_DEFENCES  CSV of defence modes (default: none,intent-tracker)
#   TEST7_REPS      Repetitions per run  (default: 20)
#   S3_BUCKET       Results bucket       (default: cko-results)
#   S3_PREFIX       S3 key prefix        (default: test7)
#   S3_REGION       Region of S3 bucket  (default: eu-west-1)
#   AWS_REGION      Region for Bedrock   (default: eu-west-2)
#   TEST7_RUN_ID    Unique run label     (default: ISO timestamp)
#
# Parallelism: run one Fargate task per model by overriding TEST7_MODELS.
#   Task A: TEST7_MODELS=claude-haiku-4-5
#   Task B: TEST7_MODELS=claude-sonnet-4-6
#   Task C: TEST7_MODELS=claude-opus-4-6
# This brings ~12h wall time down to ~4h.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Identity ──────────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Claude Code SDK prerequisites ─────────────────────────────────────────────
# The Agent SDK subprocess needs a writable HOME and ~/.claude directory
# for session state, transcripts, and config.
export HOME="${HOME:-/tmp/claude-home}"
mkdir -p "${HOME}/.claude"
echo ">>> HOME=${HOME}"

# ── Config ────────────────────────────────────────────────────────────────────
MODELS="${TEST7_MODELS:-claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-6}"
SCENARIOS="${TEST7_SCENARIOS:-intermediate,sophisticated}"
DEFENCES="${TEST7_DEFENCES:-none,intent-tracker}"
REPS="${TEST7_REPS:-20}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test7}"
S3_REGION="${S3_REGION:-eu-west-1}"       # bucket region
AWS_REGION="${AWS_REGION:-eu-west-2}"  # Bedrock region
RUN_ID="${TEST7_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

# Recommended config from test_plan.md
EMBEDDING_MODEL="amazon.titan-embed-text-v2:0"
JUDGE_MODEL="eu.anthropic.claude-haiku-4-5-20251001-v1:0"

S3_BASE="s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}"
LOG_FILE="results/run-${RUN_ID}.log"

# Tee all output to the log file so full console logs are preserved
exec > >(tee -a "${LOG_FILE}") 2>&1

# ── Startup summary ───────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════════════════════════"
echo " Test 7: Cross-Model Agent Testing"
echo "════════════════════════════════════════════════════════════════════════"
echo " RUN_ID       : ${RUN_ID}"
echo " MODELS       : ${MODELS}"
echo " SCENARIOS    : ${SCENARIOS}"
echo " DEFENCES     : ${DEFENCES}"
echo " REPS         : ${REPS}"
echo " S3           : ${S3_BASE}/ (${S3_REGION})"
echo " EMBED        : ${EMBEDDING_MODEL}"
echo " JUDGE        : ${JUDGE_MODEL}"
echo " BEDROCK      : ${AWS_REGION}"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight: verify Bedrock access ─────────────────────────────────────────
echo ""
echo ">>> Bedrock preflight check (region: ${AWS_REGION})..."

# Test embedding model with a tiny real invocation (proves IAM + model access).
# --body requires base64 in newer AWS CLI versions; pipe through base64 encoding.
EMBED_BODY=$(echo -n '{"inputText":"preflight"}' | base64)
EMBED_TEST=$(aws bedrock-runtime invoke-model \
    --region "${AWS_REGION}" \
    --model-id "${EMBEDDING_MODEL}" \
    --content-type "application/json" \
    --accept "application/json" \
    --body "${EMBED_BODY}" \
    /dev/stdout 2>&1) \
    && echo "    Embedding model OK: ${EMBEDDING_MODEL}" \
    || { echo "ERROR: Embedding model not accessible: ${EMBEDDING_MODEL}"; echo "    ${EMBED_TEST}"; exit 1; }

# Test judge model with a tiny converse call.
JUDGE_TEST=$(aws bedrock-runtime converse \
    --region "${AWS_REGION}" \
    --model-id "${JUDGE_MODEL}" \
    --messages '[{"role":"user","content":[{"text":"say ok"}]}]' \
    --inference-config '{"maxTokens":1}' \
    --output text \
    --query "output.message.content[0].text" 2>&1) \
    && echo "    Judge model OK: ${JUDGE_MODEL}" \
    || { echo "ERROR: Judge model not accessible: ${JUDGE_MODEL}"; echo "    ${JUDGE_TEST}"; exit 1; }

# ── Preflight: verify S3 access ──────────────────────────────────────────────
echo ""
echo ">>> S3 preflight check (bucket: ${S3_BUCKET}, region: ${S3_REGION})..."
echo "    Trying: aws s3 ls s3://${S3_BUCKET}/ --region ${S3_REGION}"
aws s3 ls "s3://${S3_BUCKET}/" --region "${S3_REGION}" --page-size 1 \
    && echo "    S3 list OK: s3://${S3_BUCKET}/" \
    || { echo "ERROR: Cannot list S3 bucket: s3://${S3_BUCKET}/"; exit 1; }

# Try a test write/delete to confirm put access
S3_TEST_KEY="${S3_PREFIX}/.preflight-${RUN_ID}"
echo "preflight" | aws s3 cp - "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null \
    && echo "    S3 write OK: s3://${S3_BUCKET}/${S3_PREFIX}/" \
    || { echo "ERROR: Cannot write to S3 bucket: s3://${S3_BUCKET}/${S3_PREFIX}/ — check IAM permissions"; exit 1; }
aws s3 rm "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null || true

# ── Run combinations ──────────────────────────────────────────────────────────
IFS=',' read -ra MODEL_LIST    <<< "${MODELS}"
IFS=',' read -ra SCENARIO_LIST <<< "${SCENARIOS}"
IFS=',' read -ra DEFENCE_LIST  <<< "${DEFENCES}"

TOTAL=$(( ${#MODEL_LIST[@]} * ${#SCENARIO_LIST[@]} * ${#DEFENCE_LIST[@]} ))
COUNT=0
FAILED=0

for model in "${MODEL_LIST[@]}"; do
    for scenario in "${SCENARIO_LIST[@]}"; do
        for defence in "${DEFENCE_LIST[@]}"; do
            COUNT=$(( COUNT + 1 ))
            TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
            OUTPUT_FILE="results/cross-model-${model}-${defence}-${scenario}-${TIMESTAMP}.json"

            echo ""
            echo "──────────────────────────────────────────────────────────────────────"
            echo " [${COUNT}/${TOTAL}] model=${model}  scenario=${scenario}  defence=${defence}"
            echo " output: ${OUTPUT_FILE}"
            echo "──────────────────────────────────────────────────────────────────────"

            RUN_START=$(date -u +%s)

            if npx tsx src/runner-bedrock.ts \
                --model        "${model}" \
                --scenario     "${scenario}" \
                --defence      "${defence}" \
                --repetitions  "${REPS}" \
                --embedding-backend bedrock \
                --judge-backend     bedrock \
                --embedding-model   "${EMBEDDING_MODEL}" \
                --judge-model       "${JUDGE_MODEL}" \
                --batch \
                --fail-fast \
                --output "${OUTPUT_FILE}"; then

                RUN_END=$(date -u +%s)
                echo "Completed in $(( RUN_END - RUN_START ))s"
            else
                FAILED=$(( FAILED + 1 ))
                echo "WARNING: run failed (model=${model} scenario=${scenario} defence=${defence}) — continuing"
            fi

            # Upload immediately — don't wait for all runs to finish
            if [ -f "${OUTPUT_FILE}" ]; then
                aws s3 cp "${OUTPUT_FILE}" \
                    "${S3_BASE}/$(basename "${OUTPUT_FILE}")" \
                    --region "${S3_REGION}" \
                    && echo "Uploaded: ${S3_BASE}/$(basename "${OUTPUT_FILE}")" \
                    || echo "WARNING: S3 upload failed for ${OUTPUT_FILE}"
            fi

            # Upload log file after each combination so progress is never lost
            if [ -f "${LOG_FILE}" ]; then
                aws s3 cp "${LOG_FILE}" \
                    "${S3_BASE}/$(basename "${LOG_FILE}")" \
                    --region "${S3_REGION}" 2>/dev/null || true
            fi
        done
    done
done

# ── Final sync (catches anything that failed to upload above) ─────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Final sync: results/ → ${S3_BASE}/"
echo "════════════════════════════════════════════════════════════════════════"
aws s3 sync results/ "${S3_BASE}/" --region "${S3_REGION}"

echo ""
echo " Done. ${COUNT} combinations run, ${FAILED} failed."
echo " Results: ${S3_BASE}/"
echo "════════════════════════════════════════════════════════════════════════"

# Exit non-zero if any run failed so ECS marks the task as failed
[ "${FAILED}" -eq 0 ] || exit 1
