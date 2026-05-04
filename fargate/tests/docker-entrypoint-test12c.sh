#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 12c — AgentDojo full clean rerun (B7.1-office, OpenAI models)
#
# Runs the full AgentDojo benchmark (all 4 suites) with B7.1-office defense
# using OpenAI models. Designed to be split across containers:
#
#   Container 1: MODE=security MODEL=gpt-4o      (~397 scenarios)
#   Container 2: MODE=security MODEL=gpt-4o-mini  (~397 scenarios)
#   Container 3: MODE=benign   MODEL=gpt-4o,gpt-4o-mini (97 tasks × 2)
#
# Env overrides:
#   AGENTDOJO_MODEL     gpt-4o | gpt-4o-mini | gpt-4o,gpt-4o-mini (default: gpt-4o)
#   AGENTDOJO_MODE      security | benign (default: security)
#   OPENAI_API_KEY      required
#   S3_BUCKET           results bucket (default: cko-results)
#   S3_PREFIX           results prefix (default: test12c)
#   JUDGE_REGION        Bedrock region for Dredd judge (default: eu-central-1)
# ============================================================================

MODEL="${AGENTDOJO_MODEL:-gpt-4o}"
MODE="${AGENTDOJO_MODE:-security}"
SUITES="${AGENTDOJO_SUITES:-all}"
LOG_FILE="/app/results/test12c.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test12c}"
REGION="${AWS_REGION:-eu-west-2}"
JUDGE_REGION="${JUDGE_REGION:-eu-central-1}"

echo "============================================================"
echo " Test 12c: AgentDojo full clean rerun (B7.1-office)"
echo " Model(s): ${MODEL}"
echo " Mode:     ${MODE}"
echo " Suites:   ${SUITES}"
echo " S3: s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "============================================================"

# ── Preflight ──────────────────────────────────────────────────────────────
echo "Preflight: checking OpenAI key..."
[ -n "${OPENAI_API_KEY:-}" ] || { echo "FATAL: OPENAI_API_KEY not set"; exit 1; }
echo "  OpenAI key present (${#OPENAI_API_KEY} chars)"

echo "Preflight: checking Bedrock access..."
aws bedrock-runtime converse \
  --region "${JUDGE_REGION}" \
  --model-id "eu.anthropic.claude-sonnet-4-6" \
  --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
  --inference-config '{"maxTokens":1}' \
  --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
  && echo "  Bedrock OK" \
  || { echo "FATAL: Bedrock preflight failed"; exit 1; }

echo "Preflight: checking S3 access..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${REGION}" --page-size 1 >/dev/null 2>&1 \
  && echo "  S3 OK" \
  || { echo "FATAL: Cannot list S3 bucket"; exit 1; }

# ── Start Dredd server with B7.1-office ───────────────────────────────────
DREDD_URL="http://localhost:3001"
echo "Starting Dredd server (B7.1-office, autonomous)..."
AWS_REGION="${JUDGE_REGION}" npx tsx src/server.ts \
  --backend bedrock \
  --judge-model eu.anthropic.claude-sonnet-4-6 \
  --embedding-model eu.cohere.embed-v4:0 \
  --prompt B7.1-office \
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

START_TIME=$(date +%s)

# ── Run benchmark for each model ──────────────────────────────────────────
IFS=',' read -ra MODELS <<< "${MODEL}"
for m in "${MODELS[@]}"; do
  LOGDIR="/app/results/agentdojo-${m}-office"
  mkdir -p "${LOGDIR}"

  # Build suite args
  SUITE_ARGS=()
  if [ "${SUITES}" = "all" ]; then
    SUITE_ARGS+=(--all-suites)
  else
    IFS=',' read -ra SUITE_ARRAY <<< "${SUITES}"
    for s in "${SUITE_ARRAY[@]}"; do
      SUITE_ARGS+=(--suite "${s}")
    done
  fi

  if [ "${MODE}" = "security" ]; then
    echo ""
    echo "============================================================"
    echo " ${m} — security (${SUITES}, important_instructions)"
    echo "============================================================"

    python3 /app/benchmarks/agentdojo/run_benchmark.py \
      --backend openai --model "${m}" --defense B7.1 \
      --attack important_instructions \
      "${SUITE_ARGS[@]}" \
      --logdir "${LOGDIR}" \
      --dredd-url "${DREDD_URL}" \
      -f \
      || echo "WARN: ${m} security run exited with error"

  elif [ "${MODE}" = "benign" ]; then
    echo ""
    echo "============================================================"
    echo " ${m} — benign (${SUITES}, no attack)"
    echo "============================================================"

    python3 /app/benchmarks/agentdojo/run_benchmark.py \
      --backend openai --model "${m}" --defense B7.1 \
      "${SUITE_ARGS[@]}" --attack None \
      --logdir "${LOGDIR}" \
      --dredd-url "${DREDD_URL}" \
      -f \
      || echo "WARN: ${m} benign run exited with error"
  fi

  echo "Uploading ${m} results..."
  aws s3 sync "${LOGDIR}/" "s3://${S3_BUCKET}/${S3_PREFIX}/agentdojo-${m}-office/" \
    --region "${REGION}" --quiet 2>/dev/null || true
done

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ── Stop Dredd server ─────────────────────────────────────────────────────
echo "Stopping Dredd server..."
kill "${DREDD_PID}" 2>/dev/null || true
wait "${DREDD_PID}" 2>/dev/null || true

# ── Upload log ────────────────────────────────────────────────────────────
aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test12c.log" \
  --region "${REGION}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 12c complete — ${MODE} — ${MODEL} — ${ELAPSED}s"
echo "============================================================"
