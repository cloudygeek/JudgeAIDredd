#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 17 — AgentDojo GPT-4o Tier-Match (flexible defence)
#
# Runs AgentDojo benchmark with configurable model, defence, and mode.
# Supports both defended and baseline (no-defence) arms.
#
# Env overrides:
#   AGENTDOJO_MODEL     Agent model (default: gpt-4o)
#   AGENTDOJO_MODE      security | benign (default: security)
#   AGENTDOJO_SUITES    CSV of suites or "all" (default: all)
#   AGENTDOJO_DEFENSE   Defence variant: B7.1-office | B7.1 | none (default: B7.1-office)
#   AGENTDOJO_ATTACK    Attack type (default: important_instructions)
#   OPENAI_API_KEY      Required
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           Results prefix (default: test17)
#   JUDGE_REGION        Bedrock region for Dredd judge (default: eu-central-1)
# ============================================================================

MODEL="${AGENTDOJO_MODEL:-gpt-4o}"
MODE="${AGENTDOJO_MODE:-security}"
SUITES="${AGENTDOJO_SUITES:-all}"
DEFENSE="${AGENTDOJO_DEFENSE:-B7.1-office}"
ATTACK="${AGENTDOJO_ATTACK:-important_instructions}"
LOG_FILE="/app/results/test17.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test17}"
REGION="${AWS_REGION:-eu-west-2}"
JUDGE_REGION="${JUDGE_REGION:-eu-central-1}"

echo "============================================================"
echo " Test 17: AgentDojo GPT-4o Tier-Match"
echo " Model:    ${MODEL}"
echo " Mode:     ${MODE}"
echo " Suites:   ${SUITES}"
echo " Defence:  ${DEFENSE}"
echo " Attack:   ${ATTACK}"
echo " S3: s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "============================================================"

# ── Preflight ──────────────────────────────────────────────────────────────
echo "Preflight: checking OpenAI key..."
[ -n "${OPENAI_API_KEY:-}" ] || { echo "FATAL: OPENAI_API_KEY not set"; exit 1; }
echo "  OpenAI key present (${#OPENAI_API_KEY} chars)"

echo "Preflight: checking S3 access..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${REGION}" --page-size 1 >/dev/null 2>&1 \
  && echo "  S3 OK" \
  || { echo "FATAL: Cannot list S3 bucket"; exit 1; }

# ── Start Dredd server if defence is enabled ──────────────────────────────
DREDD_URL="http://localhost:3001"
DREDD_PID=""

if [ "${DEFENSE}" != "none" ]; then
  echo "Preflight: checking Bedrock access..."
  aws bedrock-runtime converse \
    --region "${JUDGE_REGION}" \
    --model-id "eu.anthropic.claude-sonnet-4-6" \
    --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
    --inference-config '{"maxTokens":1}' \
    --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
    && echo "  Bedrock OK" \
    || { echo "FATAL: Bedrock preflight failed"; exit 1; }

  echo "Starting Dredd server (${DEFENSE}, autonomous)..."
  AWS_REGION="${JUDGE_REGION}" npx tsx src/server.ts \
    --backend bedrock \
    --judge-model eu.anthropic.claude-sonnet-4-6 \
    --embedding-model eu.cohere.embed-v4:0 \
    --prompt "${DEFENSE}" \
    --port 3001 &
  DREDD_PID=$!
  echo "  Dredd PID: ${DREDD_PID}"

  for i in $(seq 1 60); do
    if curl -s "${DREDD_URL}/health" >/dev/null 2>&1; then
      echo "  Dredd server ready (${i}s)"
      break
    fi
    sleep 1
  done
  if ! curl -s "${DREDD_URL}/health" >/dev/null 2>&1; then
    echo "FATAL: Dredd server failed to start"
    kill "${DREDD_PID}" 2>/dev/null || true
    exit 1
  fi
else
  echo "No defence — skipping Dredd server"
fi

START_TIME=$(date +%s)

# ── Build suite args ─────────────────────────────────────────────────────
SUITE_ARGS=()
if [ "${SUITES}" = "all" ]; then
  SUITE_ARGS+=(--all-suites)
else
  IFS=',' read -ra SUITE_ARRAY <<< "${SUITES}"
  for s in "${SUITE_ARRAY[@]}"; do
    SUITE_ARGS+=(--suite "${s}")
  done
fi

# ── Build defence args ───────────────────────────────────────────────────
DEFENSE_ARGS=()
DREDD_ARGS=()
if [ "${DEFENSE}" != "none" ]; then
  # Map B7.1-office → B7.1 for the benchmark runner (it only knows standard/B7/B7.1)
  BENCH_DEFENSE="${DEFENSE}"
  [ "${DEFENSE}" = "B7.1-office" ] && BENCH_DEFENSE="B7.1"
  DEFENSE_ARGS+=(--defense "${BENCH_DEFENSE}")
  DREDD_ARGS+=(--dredd-url "${DREDD_URL}")
fi

# ── Run benchmark ────────────────────────────────────────────────────────
DEFENSE_LABEL="${DEFENSE}"
[ "${DEFENSE}" = "none" ] && DEFENSE_LABEL="baseline"
LOGDIR="/app/results/agentdojo-${MODEL}-${DEFENSE_LABEL}"
mkdir -p "${LOGDIR}"

if [ "${MODE}" = "security" ]; then
  echo ""
  echo "============================================================"
  echo " ${MODEL} — security (${SUITES}, ${ATTACK}, defence=${DEFENSE})"
  echo "============================================================"

  python3 /app/benchmarks/agentdojo/run_benchmark.py \
    --backend openai --model "${MODEL}" \
    "${DEFENSE_ARGS[@]}" \
    --attack "${ATTACK}" \
    "${SUITE_ARGS[@]}" \
    --logdir "${LOGDIR}" \
    "${DREDD_ARGS[@]}" \
    -f \
    || echo "WARN: ${MODEL} security run exited with error"

elif [ "${MODE}" = "benign" ]; then
  echo ""
  echo "============================================================"
  echo " ${MODEL} — benign (${SUITES}, no attack, defence=${DEFENSE})"
  echo "============================================================"

  python3 /app/benchmarks/agentdojo/run_benchmark.py \
    --backend openai --model "${MODEL}" \
    "${DEFENSE_ARGS[@]}" \
    "${SUITE_ARGS[@]}" --attack None \
    --logdir "${LOGDIR}" \
    "${DREDD_ARGS[@]}" \
    -f \
    || echo "WARN: ${MODEL} benign run exited with error"
fi

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ── Stop Dredd server ────────────────────────────────────────────────────
if [ -n "${DREDD_PID}" ]; then
  echo "Stopping Dredd server..."
  kill "${DREDD_PID}" 2>/dev/null || true
  wait "${DREDD_PID}" 2>/dev/null || true
fi

# ── Upload results ───────────────────────────────────────────────────────
echo "Uploading results..."
aws s3 sync "${LOGDIR}/" "s3://${S3_BUCKET}/${S3_PREFIX}/agentdojo-${MODEL}-${DEFENSE_LABEL}/" \
  --region "${REGION}" --quiet 2>/dev/null || true
aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test17-${MODEL}-${MODE}-${DEFENSE_LABEL}.log" \
  --region "${REGION}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 17 complete — ${MODE} — ${MODEL} — defence=${DEFENSE} — ${ELAPSED}s"
echo "============================================================"
