#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Test 24 — MT-AgentRisk Multi-Turn Tool-Grounded Safety Benchmark
#
# Runs the MT-AgentRisk 365-scenario benchmark against a single (model, defence)
# cell. Deploy multiple containers with different env vars to parallelise the
# full 5-agent × 2-arm matrix.
#
# Env overrides:
#   TEST24_MODEL        Agent model key (default: sonnet-4.6)
#                       Options: haiku-4.5, sonnet-4.5, sonnet-4.6, opus-4.7,
#                                gpt-4o-mini, qwen3-coder
#   TEST24_DEFENCE      Defence arm: none | intent-tracker (default: none)
#   TEST24_SCENARIOS    Scenario subset: all | N-pilot | CSV (default: all)
#   TEST24_MAX_TURNS    Turn budget per scenario (default: 8)
#   AGENT_REGION        Bedrock region for agent (default: eu-west-1)
#   JUDGE_REGION        Bedrock region for Dredd + benchmark judge (default: eu-west-1)
#   S3_BUCKET           Results bucket (default: cko-results)
#   S3_PREFIX           Results prefix (default: test24)
#
# Example deployments (10 containers for full matrix):
#   Container 1:  TEST24_MODEL=haiku-4.5   TEST24_DEFENCE=none
#   Container 2:  TEST24_MODEL=haiku-4.5   TEST24_DEFENCE=intent-tracker
#   Container 3:  TEST24_MODEL=sonnet-4.6  TEST24_DEFENCE=none
#   Container 4:  TEST24_MODEL=sonnet-4.6  TEST24_DEFENCE=intent-tracker
#   Container 5:  TEST24_MODEL=opus-4.7    TEST24_DEFENCE=none
#   Container 6:  TEST24_MODEL=opus-4.7    TEST24_DEFENCE=intent-tracker
#   Container 7:  TEST24_MODEL=gpt-4o-mini TEST24_DEFENCE=none
#   Container 8:  TEST24_MODEL=gpt-4o-mini TEST24_DEFENCE=intent-tracker
#   Container 9:  TEST24_MODEL=qwen3-coder TEST24_DEFENCE=none  AGENT_REGION=eu-west-2
#   Container 10: TEST24_MODEL=qwen3-coder TEST24_DEFENCE=intent-tracker AGENT_REGION=eu-west-2
# ============================================================================

MODEL="${TEST24_MODEL:-sonnet-4.6}"
DEFENCE="${TEST24_DEFENCE:-none}"
SCENARIOS="${TEST24_SCENARIOS:-all}"
MAX_TURNS="${TEST24_MAX_TURNS:-8}"
LOG_FILE="/app/results/test24.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

S3_BUCKET="${S3_BUCKET:-cko-results}"
S3_PREFIX="${S3_PREFIX:-test24}"
REGION="${AWS_REGION:-eu-west-2}"
AGENT_REGION="${AGENT_REGION:-eu-west-1}"
JUDGE_REGION="${JUDGE_REGION:-eu-west-1}"

DEFENCE_LABEL="${DEFENCE}"
[ "${DEFENCE}" = "none" ] && DEFENCE_LABEL="baseline"

DATASET_ROOT="/app/datasets/mt-agentrisk"
OUTPUT_DIR="/app/results/test24-${MODEL}-${DEFENCE_LABEL}"

echo "============================================================"
echo " Test 24: MT-AgentRisk Multi-Turn Tool-Grounded Benchmark"
echo " Model:        ${MODEL}"
echo " Defence:      ${DEFENCE}"
echo " Scenarios:    ${SCENARIOS}"
echo " Max turns:    ${MAX_TURNS}"
echo " Agent region: ${AGENT_REGION}"
echo " Judge region: ${JUDGE_REGION}"
echo " Dataset:      ${DATASET_ROOT}"
echo " S3: s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "============================================================"

# ── Preflight ──────────────────────────────────────────────────────────────

echo "Preflight: checking dataset..."
if [ ! -d "${DATASET_ROOT}" ]; then
  echo "FATAL: Dataset not found at ${DATASET_ROOT}"
  exit 1
fi
SCENARIO_COUNT=$(find "${DATASET_ROOT}/workspaces" -name "task.md" -o -name "turns.yml" | wc -l)
echo "  Dataset OK (${SCENARIO_COUNT} task/turns files found)"

echo "Preflight: checking Bedrock judge access (${JUDGE_REGION})..."
aws bedrock-runtime converse \
  --region "${JUDGE_REGION}" \
  --model-id "eu.anthropic.claude-sonnet-4-6" \
  --messages '[{"role":"user","content":[{"text":"ok"}]}]' \
  --inference-config '{"maxTokens":1}' \
  --output text --query "output.message.content[0].text" >/dev/null 2>&1 \
  && echo "  Bedrock judge OK" \
  || { echo "FATAL: Bedrock judge preflight failed"; exit 1; }

echo "Preflight: checking S3 access..."
aws s3 ls "s3://${S3_BUCKET}/" --region "${REGION}" --page-size 1 >/dev/null 2>&1 \
  && echo "  S3 OK" \
  || { echo "FATAL: Cannot list S3 bucket"; exit 1; }

# ── Start infrastructure services ──────────────────────────────────────────

echo ""
echo "Starting infrastructure services..."

# PostgreSQL
if command -v pg_ctlcluster &>/dev/null; then
  sudo -u postgres pg_ctlcluster 15 main start 2>/dev/null || true
  echo "  PostgreSQL started"
elif command -v pg_ctl &>/dev/null; then
  pg_ctl start -D /var/lib/postgresql/data -l /tmp/pg.log 2>/dev/null || true
  echo "  PostgreSQL started"
else
  echo "  PostgreSQL not available — skipping DB-dependent scenarios"
fi

# MCP servers — launched directly using the container's own binaries
# (ToolShield start scripts hardcode /root/.nvm paths that don't exist here)
MCP_PIDS=()
NODE_BIN=$(which node)
FS_SERVER="./node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"
PW_SERVER="./node_modules/@playwright/mcp/cli.js"

# Filesystem MCP (port 9090)
if [ -f "${FS_SERVER}" ]; then
  mkdir -p /tmp/mcp-workspace
  npx supergateway --port 9090 \
    --stdio "${NODE_BIN} ${FS_SERVER} /tmp/mcp-workspace /tmp /app" &
  MCP_PIDS+=($!)
  echo "  Started filesystem MCP (PID ${MCP_PIDS[-1]})"
fi

# PostgreSQL MCP (port 9091)
if command -v postgres-mcp &>/dev/null; then
  PG_URL="postgresql://postgres:password@localhost:5432/postgres"
  npx supergateway --port 9091 \
    --stdio "postgres-mcp ${PG_URL}" &
  MCP_PIDS+=($!)
  echo "  Started postgres MCP (PID ${MCP_PIDS[-1]})"
fi

# Playwright/Browser MCP (port 9092)
# Uses apt-installed chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH env var
if [ -f "${PW_SERVER}" ]; then
  PW_TEMP=$(mktemp -d -t playwright_session_XXXXXX)
  npx supergateway --port 9092 \
    --stdio "env HOME=${PW_TEMP} ${NODE_BIN} ${PW_SERVER} --isolated --no-sandbox" &
  MCP_PIDS+=($!)
  echo "  Started browser MCP (PID ${MCP_PIDS[-1]})"
fi

# Notion MCP (port 9097)
npx supergateway --port 9097 \
  --stdio "npx -y @notionhq/notion-mcp-server" &
MCP_PIDS+=($!)
echo "  Started notion MCP (PID ${MCP_PIDS[-1]})"

# Wait for MCP server readiness
echo "Waiting for MCP servers..."
for port in 9090 9091 9092 9097; do
  READY=false
  for i in $(seq 1 30); do
    if curl -s "http://localhost:${port}/sse" -o /dev/null -w "%{http_code}" 2>/dev/null | grep -q "200"; then
      READY=true
      break
    fi
    sleep 1
  done
  if [ "${READY}" = "true" ]; then
    echo "  Port ${port} ready"
  else
    echo "  WARNING: Port ${port} not responding after 30s"
  fi
done

# ── Start Dredd server if defence is enabled ──────────────────────────────

DREDD_URL="http://localhost:3001"
DREDD_PID=""

if [ "${DEFENCE}" != "none" ]; then
  echo ""
  echo "Starting Dredd server (B7.1, autonomous)..."
  AWS_REGION="${JUDGE_REGION}" npx tsx src/server.ts \
    --backend bedrock \
    --judge-model eu.anthropic.claude-sonnet-4-6 \
    --embedding-model eu.cohere.embed-v4:0 \
    --prompt B7.1 \
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

# ── Run benchmark ────────────────────────────────────────────────────────

mkdir -p "${OUTPUT_DIR}"

echo ""
echo "============================================================"
echo " Running: ${MODEL} — defence=${DEFENCE} — scenarios=${SCENARIOS}"
echo "============================================================"

DREDD_ARGS=()
if [ "${DEFENCE}" != "none" ]; then
  DREDD_ARGS+=(--dredd-url "${DREDD_URL}")
fi

python3 /app/benchmarks/mt_agentrisk/run_benchmark.py \
  --models "${MODEL}" \
  --scenarios "${SCENARIOS}" \
  --defences "${DEFENCE}" \
  --max-turns "${MAX_TURNS}" \
  --benchmark-judge-model eu.anthropic.claude-sonnet-4-6 \
  --benchmark-judge-region "${JUDGE_REGION}" \
  --dredd-judge-model eu.anthropic.claude-sonnet-4-6 \
  --dredd-judge-prompt B7.1 \
  --embed-model eu.cohere.embed-v4:0 \
  --output-dir "${OUTPUT_DIR}" \
  --dataset-root "${DATASET_ROOT}" \
  --agent-region "${AGENT_REGION}" \
  "${DREDD_ARGS[@]}" \
  || echo "WARN: Benchmark run exited with error"

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ── Stop services ────────────────────────────────────────────────────────

if [ -n "${DREDD_PID}" ]; then
  echo "Stopping Dredd server..."
  kill "${DREDD_PID}" 2>/dev/null || true
  wait "${DREDD_PID}" 2>/dev/null || true
fi

for pid in "${MCP_PIDS[@]}"; do
  kill "${pid}" 2>/dev/null || true
done

# ── Upload results ───────────────────────────────────────────────────────

echo "Uploading results..."
aws s3 sync "${OUTPUT_DIR}/" \
  "s3://${S3_BUCKET}/${S3_PREFIX}/test24-${MODEL}-${DEFENCE_LABEL}/" \
  --region "${REGION}" --quiet 2>/dev/null || true
aws s3 cp "${LOG_FILE}" \
  "s3://${S3_BUCKET}/${S3_PREFIX}/test24-${MODEL}-${DEFENCE_LABEL}.log" \
  --region "${REGION}" 2>/dev/null || true

echo ""
echo "============================================================"
echo " Test 24 complete — ${MODEL} — defence=${DEFENCE} — ${ELAPSED}s"
echo "============================================================"
