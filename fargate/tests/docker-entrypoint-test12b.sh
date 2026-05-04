#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 12b — AgentDojo repeat-run for compromised scenarios
#
# Reruns a specific set of (user_task, injection_task) pairs N times with
# --force-rerun, writing each rep to a separate logdir so results don't
# overwrite each other.
#
# Env overrides:
#   REPS                number of repetitions (default: 4)
#   OPENAI_API_KEY      required — OpenAI API key
#   AGENTDOJO_MODEL     gpt-4o | gpt-4o-mini (default: gpt-4o)
#   S3_BUCKET           results bucket (default: cko-results)
#   S3_PREFIX           results prefix (default: test12b)
#   JUDGE_REGION        Bedrock region for Dredd judge (default: eu-central-1)
# ============================================================================

REPS="${REPS:-4}"
MODEL="${AGENTDOJO_MODEL:-gpt-4o}"
LOG_FILE="/app/results/test12b.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test12b}"
REGION="${AWS_REGION:-eu-west-2}"
JUDGE_REGION="${JUDGE_REGION:-eu-central-1}"

echo "============================================================"
echo " Test 12b: AgentDojo compromised-scenario repeat-run"
echo " Model: ${MODEL}  Reps: ${REPS}"
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

# ── Download pair file ────────────────────────────────────────────────────
PAIRS_FILE="/app/results/compromised-pairs.json"
echo "Downloading pair file from S3..."
aws s3 cp "s3://${S3_BUCKET}/${S3_PREFIX}/compromised-pairs.json" "${PAIRS_FILE}" \
  --region "${REGION}" \
  && echo "  Pair file OK" \
  || { echo "FATAL: Cannot download pair file"; exit 1; }

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

# ── Run N repetitions ─────────────────────────────────────────────────────
for rep in $(seq 1 "${REPS}"); do
  echo ""
  echo "============================================================"
  echo " Rep ${rep}/${REPS} — ${MODEL}"
  echo "============================================================"

  LOGDIR="/app/results/agentdojo-rerun-${MODEL}/rep${rep}"
  mkdir -p "${LOGDIR}"

  python3 /app/benchmarks/agentdojo/run_benchmark.py \
    --backend openai --model "${MODEL}" --defense B7.1 \
    --attack important_instructions \
    --pair-file "${PAIRS_FILE}" \
    --logdir "${LOGDIR}" \
    --dredd-url "${DREDD_URL}" \
    -f \
    || echo "WARN: Rep ${rep} exited with error"

  echo "Rep ${rep} done. Uploading..."
  aws s3 sync "${LOGDIR}/" "s3://${S3_BUCKET}/${S3_PREFIX}/agentdojo-rerun-${MODEL}/rep${rep}/" \
    --region "${REGION}" --quiet 2>/dev/null || true
done

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ── Stop Dredd server ─────────────────────────────────────────────────────
echo "Stopping Dredd server..."
kill "${DREDD_PID}" 2>/dev/null || true
wait "${DREDD_PID}" 2>/dev/null || true

# ── Upload log ────────────────────────────────────────────────────────────
aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test12b.log" \
  --region "${REGION}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 12b complete — ${REPS} reps × 9 pairs — ${ELAPSED}s"
echo "============================================================"
