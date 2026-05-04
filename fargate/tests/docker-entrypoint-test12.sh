#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 12 — AgentDojo External Benchmark
#
# Runs the AgentDojo indirect prompt injection benchmark with optional
# Judge Dredd defense.  The Dredd server starts as a background process
# so the Python benchmark runner can call /intent and /evaluate.
#
# Env overrides:
#   AGENTDOJO_MODEL     haiku | sonnet (default: haiku)
#   AGENTDOJO_ATTACK    attack name (default: important_instructions)
#   AGENTDOJO_SUITES    comma-separated suites (default: workspace)
#   AGENTDOJO_DEFENSE   none | B7.1 (default: none = baseline)
#   AGENTDOJO_TASKS     comma-separated user_task IDs to run (default: all)
#   S3_BUCKET           results bucket (default: cko-results)
#   S3_PREFIX           results prefix (default: test12)
# ============================================================================

LOG_FILE="/app/results/test12.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test12}"
MODEL="${AGENTDOJO_MODEL:-haiku}"
ATTACK="${AGENTDOJO_ATTACK:-important_instructions}"
SUITES="${AGENTDOJO_SUITES:-workspace}"
DEFENSE="${AGENTDOJO_DEFENSE:-none}"
USER_TASKS="${AGENTDOJO_TASKS:-}"
REGION="${AWS_REGION:-eu-west-2}"

echo "============================================================"
echo " Test 12: AgentDojo External Benchmark"
echo " Model:    ${MODEL}"
echo " Attack:   ${ATTACK}"
echo " Suites:   ${SUITES}"
echo " Defense:  ${DEFENSE}"
echo " Tasks:    ${USER_TASKS:-all}"
echo " S3: s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "============================================================"

# ── Preflight ──────────────────────────────────────────────────────────────
echo "Preflight: checking Bedrock access..."
aws bedrock-runtime converse \
  --region "${REGION}" \
  --model-id "eu.anthropic.claude-haiku-4-5-20251001-v1:0" \
  --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
  --inference-config '{"maxTokens":1}' \
  --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
  && echo "  Bedrock OK" \
  || { echo "  WARN: Bedrock preflight failed, continuing anyway"; }

echo "Preflight: checking S3 access..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${REGION}" --page-size 1 >/dev/null 2>&1 \
  && echo "  S3 OK" \
  || { echo "  FATAL: Cannot list S3 bucket. Aborting."; exit 1; }

# ── Start Dredd server (if defense enabled) ────────────────────────────────
DREDD_URL="http://localhost:3001"
if [ "${DEFENSE}" != "none" ]; then
  echo "Starting Dredd server (B7.1 hardened, autonomous)..."
  AWS_REGION="${REGION}" npx tsx src/server.ts \
    --backend bedrock \
    --judge-model eu.anthropic.claude-sonnet-4-6 \
    --embedding-model eu.cohere.embed-v4:0 \
    --hardened \
    --port 3001 &
  DREDD_PID=$!
  echo "  Dredd PID: ${DREDD_PID}"

  # Wait for server to be ready
  for i in $(seq 1 30); do
    if curl -s "${DREDD_URL}/health" >/dev/null 2>&1; then
      echo "  Dredd server ready (${i}s)"
      break
    fi
    sleep 1
  done
  if ! curl -s "${DREDD_URL}/health" >/dev/null 2>&1; then
    echo "  FATAL: Dredd server failed to start"
    exit 1
  fi
fi

# ── Build benchmark command ────────────────────────────────────────────────
LOGDIR="/app/results/agentdojo"
mkdir -p "${LOGDIR}"

CMD_ARGS=(
  python3 /app/benchmarks/agentdojo/run_benchmark.py
  --model "${MODEL}"
  --backend bedrock
  --aws-region "${REGION}"
  --attack "${ATTACK}"
  --logdir "${LOGDIR}"
  --dredd-url "${DREDD_URL}"
  -f
)

if [ "${DEFENSE}" != "none" ]; then
  CMD_ARGS+=(--defense "${DEFENSE}")
fi

# Add suites
IFS=',' read -ra SUITE_ARRAY <<< "${SUITES}"
for suite in "${SUITE_ARRAY[@]}"; do
  CMD_ARGS+=(--suite "${suite}")
done

# Add specific user tasks if set
if [ -n "${USER_TASKS}" ]; then
  IFS=',' read -ra TASK_ARRAY <<< "${USER_TASKS}"
  for task in "${TASK_ARRAY[@]}"; do
    CMD_ARGS+=(-ut "${task}")
  done
fi

echo ""
echo "Running: ${CMD_ARGS[*]}"
echo ""

START_TIME=$(date +%s)

"${CMD_ARGS[@]}" || {
  echo "  FAILED: benchmark exited with error"
}

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
echo ""
echo "Benchmark completed in ${ELAPSED}s"

# ── Stop Dredd server ──────────────────────────────────────────────────────
if [ -n "${DREDD_PID:-}" ]; then
  echo "Stopping Dredd server..."
  kill "${DREDD_PID}" 2>/dev/null || true
  wait "${DREDD_PID}" 2>/dev/null || true
fi

# ── Upload results ─────────────────────────────────────────────────────────
echo ""
echo "Uploading results to S3..."
aws s3 sync "${LOGDIR}/" "s3://${S3_BUCKET}/${S3_PREFIX}/" \
  --region "${REGION}" 2>/dev/null \
  && echo "  S3 sync OK" \
  || echo "  WARN: S3 sync failed"

# Upload log
aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test12.log" \
  --region "${REGION}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 12 complete — ${ELAPSED}s"
echo "============================================================"
