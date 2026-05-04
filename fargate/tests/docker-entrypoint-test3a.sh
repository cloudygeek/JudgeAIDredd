#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Test 3a: Statistical Robustness — Opus 4.7 + effort sweep
#
# Adds Opus 4.7 at none and high effort to the Test 3 matrix.
# Only runs the NEW combinations not covered by the original Test 3.
#
# Default matrix:
#   Opus 4.7 (none effort):  3 scenarios × 2 defences × 90 reps = 540 runs
#   Opus 4.7 (high effort):  3 scenarios × 2 defences × 90 reps = 540 runs
#   Total: 1080 runs
#
# Optional env vars:
#   TEST3A_EFFORTS    CSV of effort levels   (default: none,high)
#   TEST3A_REPS       Reps per combo         (default: 90)
#   TEST3_SCENARIOS   CSV of scenarios       (default: naive,intermediate,sophisticated)
#   TEST3_DEFENCES    CSV of defence modes   (default: none,intent-tracker)
#   PARALLEL_JOBS     Max concurrent combos  (default: 4)
#   S3_BUCKET         Results bucket         (default: cko-results)
#   S3_PREFIX         S3 key prefix          (default: test3a)
#   S3_REGION         Region of S3 bucket    (default: eu-west-1)
#   AWS_REGION        Region for Bedrock     (default: eu-west-2)
#   TEST3A_RUN_ID     Unique run label       (default: ISO timestamp)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Identity ──────────────────────────────────────────────────────────────────
echo ">>> Caller identity:"
aws sts get-caller-identity || echo "WARNING: unable to retrieve caller identity"
echo ""

# ── Claude Code SDK prerequisites ─────────────────────────────────────────────
export HOME="${HOME:-/tmp/claude-home}"
mkdir -p "${HOME}/.claude"
echo ">>> HOME=${HOME}"

# ── Config ────────────────────────────────────────────────────────────────────
MODEL="claude-opus-4-7"
EFFORTS="${TEST3A_EFFORTS:-none,high}"
REPS="${TEST3A_REPS:-90}"
SCENARIOS="${TEST3_SCENARIOS:-naive,intermediate,sophisticated}"
DEFENCES="${TEST3_DEFENCES:-none,intent-tracker}"
PARALLEL="${PARALLEL_JOBS:-4}"
S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test3a}"
S3_REGION="${S3_REGION:-eu-west-1}"
AWS_REGION="${AWS_REGION:-eu-west-2}"
RUN_ID="${TEST3A_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

EMBEDDING_MODEL="amazon.titan-embed-text-v2:0"
JUDGE_MODEL="eu.anthropic.claude-haiku-4-5-20251001-v1:0"

S3_BASE="s3://${S3_BUCKET}/${S3_PREFIX}/${RUN_ID}"
LOG_FILE="results/run-${RUN_ID}.log"

exec > >(tee -a "${LOG_FILE}") 2>&1

# ── Startup summary ───────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════════════════════════"
echo " Test 3a: Statistical Robustness — Opus 4.7 + Effort Sweep"
echo "════════════════════════════════════════════════════════════════════════"
echo " RUN_ID       : ${RUN_ID}"
echo " MODEL        : ${MODEL}"
echo " EFFORTS      : ${EFFORTS}"
echo " REPS         : ${REPS}"
echo " SCENARIOS    : ${SCENARIOS}"
echo " DEFENCES     : ${DEFENCES}"
echo " PARALLEL     : ${PARALLEL} concurrent jobs"
echo " S3           : ${S3_BASE}/ (${S3_REGION})"
echo " EMBED        : ${EMBEDDING_MODEL}"
echo " JUDGE        : ${JUDGE_MODEL}"
echo " BEDROCK      : ${AWS_REGION}"
echo "════════════════════════════════════════════════════════════════════════"

# ── Preflight: verify Bedrock access ─────────────────────────────────────────
echo ""
echo ">>> Bedrock preflight check (region: ${AWS_REGION})..."

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

JUDGE_TEST=$(aws bedrock-runtime converse \
    --region "${AWS_REGION}" \
    --model-id "${JUDGE_MODEL}" \
    --messages '[{"role":"user","content":[{"text":"say ok"}]}]' \
    --inference-config '{"maxTokens":1}' \
    --output text \
    --query "output.message.content[0].text" 2>&1) \
    && echo "    Judge model OK: ${JUDGE_MODEL}" \
    || { echo "ERROR: Judge model not accessible: ${JUDGE_MODEL}"; echo "    ${JUDGE_TEST}"; exit 1; }

# Test Opus 4.7 agent model access
OPUS_TEST=$(aws bedrock-runtime converse \
    --region "${AWS_REGION}" \
    --model-id "eu.anthropic.claude-opus-4-7" \
    --messages '[{"role":"user","content":[{"text":"say ok"}]}]' \
    --inference-config '{"maxTokens":1}' \
    --output text \
    --query "output.message.content[0].text" 2>&1) \
    && echo "    Agent model OK: eu.anthropic.claude-opus-4-7" \
    || { echo "ERROR: Opus 4.7 not accessible"; echo "    ${OPUS_TEST}"; exit 1; }

# ── Preflight: verify S3 access ──────────────────────────────────────────────
echo ""
echo ">>> S3 preflight check (bucket: ${S3_BUCKET}, region: ${S3_REGION})..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${S3_REGION}" --page-size 1 \
    && echo "    S3 list OK" \
    || { echo "ERROR: Cannot list S3 bucket: s3://${S3_BUCKET}/"; exit 1; }

S3_TEST_KEY="${S3_PREFIX}/.preflight-${RUN_ID}"
echo "preflight" | aws s3 cp - "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null \
    && echo "    S3 write OK" \
    || { echo "ERROR: Cannot write to S3 bucket"; exit 1; }
aws s3 rm "s3://${S3_BUCKET}/${S3_TEST_KEY}" --region "${S3_REGION}" 2>/dev/null || true

# ── Build job list ────────────────────────────────────────────────────────────
IFS=',' read -ra EFFORT_LIST   <<< "${EFFORTS}"
IFS=',' read -ra SCENARIO_LIST <<< "${SCENARIOS}"
IFS=',' read -ra DEFENCE_LIST  <<< "${DEFENCES}"

declare -a JOBS=()

for effort in "${EFFORT_LIST[@]}"; do
    for scenario in "${SCENARIO_LIST[@]}"; do
        for defence in "${DEFENCE_LIST[@]}"; do
            JOBS+=("${effort}|${scenario}|${defence}")
        done
    done
done

TOTAL=${#JOBS[@]}
echo ""
echo ">>> ${TOTAL} combinations queued, running ${PARALLEL} in parallel"
echo ""

# ── Run a single combination ─────────────────────────────────────────────────
run_combo() {
    local job_num="$1"
    local effort="$2"
    local scenario="$3"
    local defence="$4"

    local TIMESTAMP
    TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
    local effort_tag="${effort}"
    [ "${effort}" = "none" ] && effort_tag="default"
    local OUTPUT_FILE="results/robustness-${MODEL}-${effort_tag}-${defence}-${scenario}-${TIMESTAMP}.json"
    local JOB_LOG="results/job-${MODEL}-${effort_tag}-${defence}-${scenario}-${TIMESTAMP}.log"

    {
        echo "──────────────────────────────────────────────────────────────────────"
        echo " [${job_num}/${TOTAL}] model=${MODEL}  effort=${effort}  scenario=${scenario}  defence=${defence}  reps=${REPS}"
        echo " output: ${OUTPUT_FILE}"
        echo "──────────────────────────────────────────────────────────────────────"

        local RUN_START
        RUN_START=$(date -u +%s)

        local CMD=(npx tsx src/tests/runner-bedrock.ts
            --model        "${MODEL}"
            --scenario     "${scenario}"
            --defence      "${defence}"
            --repetitions  "${REPS}"
            --embedding-backend bedrock
            --judge-backend     bedrock
            --embedding-model   "${EMBEDDING_MODEL}"
            --judge-model       "${JUDGE_MODEL}"
            --batch
            --output "${OUTPUT_FILE}")

        if [ "${effort}" != "none" ]; then
            CMD+=(--effort "${effort}")
        fi

        if "${CMD[@]}"; then
            local RUN_END
            RUN_END=$(date -u +%s)
            echo "[${job_num}/${TOTAL}] DONE in $(( RUN_END - RUN_START ))s: ${MODEL} effort=${effort} ${defence} ${scenario}"
        else
            echo "[${job_num}/${TOTAL}] FAILED: ${MODEL} effort=${effort} ${defence} ${scenario}"
            return 1
        fi

        # Upload result to S3
        if [ -f "${OUTPUT_FILE}" ]; then
            aws s3 cp "${OUTPUT_FILE}" \
                "${S3_BASE}/$(basename "${OUTPUT_FILE}")" \
                --region "${S3_REGION}" \
                && echo "[${job_num}] Uploaded: $(basename "${OUTPUT_FILE}")" \
                || echo "[${job_num}] WARNING: S3 upload failed for ${OUTPUT_FILE}"
        fi
    } 2>&1 | tee -a "${JOB_LOG}"

    if [ -f "${JOB_LOG}" ]; then
        aws s3 cp "${JOB_LOG}" \
            "${S3_BASE}/logs/$(basename "${JOB_LOG}")" \
            --region "${S3_REGION}" 2>/dev/null || true
    fi
}

# ── Parallel dispatcher ──────────────────────────────────────────────────────
RUNNING_PIDS=()
FAILED=0

wait_for_slot() {
    while [ ${#RUNNING_PIDS[@]} -ge "${PARALLEL}" ]; do
        local new_pids=()
        for pid in "${RUNNING_PIDS[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                new_pids+=("$pid")
            else
                wait "$pid" || FAILED=$(( FAILED + 1 ))
            fi
        done
        RUNNING_PIDS=("${new_pids[@]}")
        if [ ${#RUNNING_PIDS[@]} -ge "${PARALLEL}" ]; then
            sleep 2
        fi
    done
}

wait_for_all() {
    for pid in "${RUNNING_PIDS[@]}"; do
        wait "$pid" || FAILED=$(( FAILED + 1 ))
    done
    RUNNING_PIDS=()
}

echo "════════════════════════════════════════════════════════════════════════"
echo " Launching jobs..."
echo "════════════════════════════════════════════════════════════════════════"

JOB_NUM=0
for job in "${JOBS[@]}"; do
    JOB_NUM=$(( JOB_NUM + 1 ))
    IFS='|' read -r effort scenario defence <<< "${job}"

    wait_for_slot

    echo ">>> Launching [${JOB_NUM}/${TOTAL}]: ${MODEL} effort=${effort} ${defence} ${scenario} (${REPS} reps)"
    run_combo "${JOB_NUM}" "${effort}" "${scenario}" "${defence}" &
    RUNNING_PIDS+=($!)
done

echo ""
echo ">>> All ${TOTAL} jobs launched. Waiting for completion..."
wait_for_all

# ── Upload consolidated log ──────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo " Final sync: results/ → ${S3_BASE}/"
echo "════════════════════════════════════════════════════════════════════════"
aws s3 sync results/ "${S3_BASE}/" --region "${S3_REGION}"

echo ""
echo " Done. ${TOTAL} combinations run, ${FAILED} failed."
echo " Results: ${S3_BASE}/"
echo "════════════════════════════════════════════════════════════════════════"

[ "${FAILED}" -eq 0 ] || exit 1
