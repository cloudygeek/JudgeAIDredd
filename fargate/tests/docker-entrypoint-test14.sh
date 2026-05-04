#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 14 — Prompt-Reduction Corpus Benchmark
#
# Runs the full corpus of tool-call traces against Judge Dredd in interactive
# mode and aggregates per-trace + corpus-level prompt-reduction figures.
#
# Env overrides:
#   DREDD_PORT      Dredd server port (default: 3456)
#   JUDGE_REGION    Bedrock region (default: eu-central-1)
#   REPS            Number of replay repetitions per trace (default: 10)
#   S3_BUCKET       Results bucket (default: cko-results)
#   S3_PREFIX       Results prefix (default: test14)
# ============================================================================

DREDD_PORT="${DREDD_PORT:-3456}"
JUDGE_REGION="${JUDGE_REGION:-eu-central-1}"
REPS="${REPS:-10}"
LOG_FILE="/app/results/test14.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test14}"
REGION="${AWS_REGION:-eu-west-2}"

echo "============================================================"
echo " Test 14: Prompt-Reduction Corpus Benchmark"
echo " Reps:    ${REPS} per trace"
echo " S3: s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "============================================================"

# ── Preflight ──────────────────────────────────────────────────────────────
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

# ── Start Dredd server (interactive mode, standard prompt) ────────────────
DREDD_URL="http://localhost:${DREDD_PORT}"
echo "Starting Dredd server (interactive mode, Bedrock, standard prompt)..."

AWS_REGION="${JUDGE_REGION}" npx tsx src/server.ts \
  --backend bedrock \
  --judge-model eu.anthropic.claude-sonnet-4-6 \
  --embedding-model eu.cohere.embed-v4:0 \
  --mode interactive \
  --port "${DREDD_PORT}" &
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

# ── Run corpus benchmark ─────────────────────────────────────────────────
RESULTS_DIR="/app/results/prompt-reduction-corpus"
mkdir -p "${RESULTS_DIR}"

echo ""
echo "============================================================"
echo " Running prompt-reduction corpus (${REPS} reps per trace)"
echo "============================================================"

cd /app/benchmarks/prompt-reduction

TRACES=(traces/*.json)
echo "Traces: ${#TRACES[@]}"
for t in "${TRACES[@]}"; do
  echo "  - $(basename "$t")"
done
echo ""

for trace in "${TRACES[@]}"; do
  name=$(basename "${trace}" .json)
  out="${RESULTS_DIR}/${name}.json"
  echo "=== ${name} ==="
  DREDD_URL="${DREDD_URL}" npx tsx measure-prompts.ts \
    --trace "${trace}" \
    --dredd-url "${DREDD_URL}" \
    --reps "${REPS}" \
    --out "${out}" \
    || echo "WARN: ${name} exited with error"
  echo ""
done

# ── Aggregate ─────────────────────────────────────────────────────────────
echo "Aggregating corpus results..."
npx tsx aggregate-corpus.ts "${RESULTS_DIR}" | tee "${RESULTS_DIR}/summary.txt"

cd /app

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ── Stop Dredd server ─────────────────────────────────────────────────────
echo "Stopping Dredd server..."
kill "${DREDD_PID}" 2>/dev/null || true
wait "${DREDD_PID}" 2>/dev/null || true

# ── Upload results ────────────────────────────────────────────────────────
echo "Uploading results..."
aws s3 sync "${RESULTS_DIR}/" "s3://${S3_BUCKET}/${S3_PREFIX}/" \
  --region "${REGION}" --quiet 2>/dev/null || true
aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test14.log" \
  --region "${REGION}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 14 complete — ${ELAPSED}s"
echo "============================================================"
