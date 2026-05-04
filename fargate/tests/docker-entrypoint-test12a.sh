#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 12a — AgentDojo B7.1-office rerun (tainted-by-token-expiry scenarios)
#
# Reruns only the phases invalidated by AWS Bearer Token expiry mid-run:
#   Phase 1: gpt-4o-mini security — workspace only (pair-filtered, 96 pairs)
#   Phase 2: gpt-4o benign — all 97 tasks, all 4 suites
#   Phase 3: gpt-4o-mini benign — all 97 tasks, all 4 suites
#
# Set PHASE=1|2|3 to run a single phase per container. Omit PHASE to run all
# three serially (original behaviour).
#
# Env overrides:
#   PHASE               1, 2, or 3 (default: all)
#   OPENAI_API_KEY      required — OpenAI API key
#   S3_BUCKET           results bucket (default: cko-results)
#   S3_PREFIX           results prefix (default: test12a)
#   S3_SEED_PREFIX_4O   S3 prefix for existing gpt-4o results to seed
#   S3_SEED_PREFIX_MINI S3 prefix for existing gpt-4o-mini results to seed
# ============================================================================

PHASE="${PHASE:-all}"
LOG_FILE="/app/results/test12a-phase${PHASE}.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test12a}"
S3_SEED_PREFIX_4O="${S3_SEED_PREFIX_4O:-}"
S3_SEED_PREFIX_MINI="${S3_SEED_PREFIX_MINI:-}"
REGION="${AWS_REGION:-eu-west-2}"
JUDGE_REGION="${JUDGE_REGION:-eu-central-1}"

echo "============================================================"
echo " Test 12a: AgentDojo B7.1-office rerun"
echo " Phase:  ${PHASE}"
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

# ── Seed existing clean results from S3 ───────────────────────────────────
LOGDIR_4O="/app/results/agentdojo-gpt4o-office"
LOGDIR_MINI="/app/results/agentdojo-gpt4o-mini-office"
mkdir -p "${LOGDIR_4O}" "${LOGDIR_MINI}"

if [ -n "${S3_SEED_PREFIX_4O}" ] && [[ "${PHASE}" == "all" || "${PHASE}" == "2" ]]; then
  echo "Seeding gpt-4o results from s3://${S3_BUCKET}/${S3_SEED_PREFIX_4O}/ ..."
  aws s3 sync "s3://${S3_BUCKET}/${S3_SEED_PREFIX_4O}/" "${LOGDIR_4O}/" \
    --region "${REGION}" --quiet
  echo "  Seeded $(find "${LOGDIR_4O}" -name '*.json' | wc -l) files"
fi

if [ -n "${S3_SEED_PREFIX_MINI}" ] && [[ "${PHASE}" == "all" || "${PHASE}" == "1" || "${PHASE}" == "3" ]]; then
  echo "Seeding gpt-4o-mini results from s3://${S3_BUCKET}/${S3_SEED_PREFIX_MINI}/ ..."
  aws s3 sync "s3://${S3_BUCKET}/${S3_SEED_PREFIX_MINI}/" "${LOGDIR_MINI}/" \
    --region "${REGION}" --quiet
  echo "  Seeded $(find "${LOGDIR_MINI}" -name '*.json' | wc -l) files"
fi

# Download pair file (only needed for phase 1)
if [[ "${PHASE}" == "all" || "${PHASE}" == "1" ]]; then
  PAIRS_DIR="/app/results/agentdojo-gpt4o-mini-baseline"
  mkdir -p "${PAIRS_DIR}"
  echo "Downloading pair files from S3..."
  aws s3 cp "s3://${S3_BUCKET}/${S3_PREFIX}/successful-pairs-workspace.json" \
    "${PAIRS_DIR}/successful-pairs-workspace.json" \
    --region "${REGION}" \
    && echo "  Workspace pair file OK" \
    || { echo "FATAL: Cannot download workspace pair file"; exit 1; }
fi

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

# ── Phase 1: gpt-4o-mini workspace security (pair-filtered) ──────────────
if [[ "${PHASE}" == "all" || "${PHASE}" == "1" ]]; then
  echo ""
  echo "============================================================"
  echo " Phase 1: gpt-4o-mini workspace security (pair-filtered)"
  echo "============================================================"

  python3 /app/benchmarks/agentdojo/run_benchmark.py \
    --backend openai --model gpt-4o-mini --defense B7.1 \
    --attack important_instructions \
    --pair-file /app/results/agentdojo-gpt4o-mini-baseline/successful-pairs-workspace.json \
    --logdir "${LOGDIR_MINI}" \
    --dredd-url "${DREDD_URL}" \
    || echo "WARN: Phase 1 exited with error"

  echo "Phase 1 done. Uploading results..."
  aws s3 sync "${LOGDIR_MINI}/" "s3://${S3_BUCKET}/${S3_PREFIX}/agentdojo-gpt4o-mini-office/" \
    --region "${REGION}" --quiet 2>/dev/null || true
fi

# ── Phase 2: gpt-4o benign (all 97 tasks) ────────────────────────────────
if [[ "${PHASE}" == "all" || "${PHASE}" == "2" ]]; then
  echo ""
  echo "============================================================"
  echo " Phase 2: gpt-4o benign (97 tasks × 4 suites)"
  echo "============================================================"

  python3 /app/benchmarks/agentdojo/run_benchmark.py \
    --backend openai --model gpt-4o --defense B7.1 \
    --all-suites --attack None \
    --logdir "${LOGDIR_4O}" \
    --dredd-url "${DREDD_URL}" \
    || echo "WARN: Phase 2 exited with error"

  echo "Phase 2 done. Uploading results..."
  aws s3 sync "${LOGDIR_4O}/" "s3://${S3_BUCKET}/${S3_PREFIX}/agentdojo-gpt4o-office/" \
    --region "${REGION}" --quiet 2>/dev/null || true
fi

# ── Phase 3: gpt-4o-mini benign (all 97 tasks) ───────────────────────────
if [[ "${PHASE}" == "all" || "${PHASE}" == "3" ]]; then
  echo ""
  echo "============================================================"
  echo " Phase 3: gpt-4o-mini benign (97 tasks × 4 suites)"
  echo "============================================================"

  python3 /app/benchmarks/agentdojo/run_benchmark.py \
    --backend openai --model gpt-4o-mini --defense B7.1 \
    --all-suites --attack None \
    --logdir "${LOGDIR_MINI}" \
    --dredd-url "${DREDD_URL}" \
    || echo "WARN: Phase 3 exited with error"

  echo "Phase 3 done. Uploading results..."
  aws s3 sync "${LOGDIR_MINI}/" "s3://${S3_BUCKET}/${S3_PREFIX}/agentdojo-gpt4o-mini-office/" \
    --region "${REGION}" --quiet 2>/dev/null || true
fi

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ── Stop Dredd server ─────────────────────────────────────────────────────
echo "Stopping Dredd server..."
kill "${DREDD_PID}" 2>/dev/null || true
wait "${DREDD_PID}" 2>/dev/null || true

# ── Upload log ────────────────────────────────────────────────────────────
aws s3 cp "${LOG_FILE}" "s3://${S3_BUCKET}/${S3_PREFIX}/test12a-phase${PHASE}.log" \
  --region "${REGION}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 12a phase ${PHASE} complete — ${ELAPSED}s"
echo "============================================================"
