#!/usr/bin/env bash
set -euo pipefail

# Run Test 1 configs in parallel (one process per config).
# Designed for nomic-embed-text (Ollama) configs that can't run on Fargate.
#
# Usage: ./run-test1-local-parallel.sh [configs] [effort-levels]
#   e.g.  ./run-test1-local-parallel.sh A,C,E,G default,low,medium,high,max

CONFIGS="${1:-A,C,E,G}"
EFFORT_LEVELS="${2:-default,low,medium,high,max}"

# Gate: refuse to run with uncommitted changes unless overridden
if [[ -n "$(git status --porcelain)" ]]; then
  echo "FATAL: working tree dirty — commit or stash before running a reference test."
  echo "  Override with ALLOW_DIRTY=1 for ad-hoc experimentation."
  [[ "${ALLOW_DIRTY:-0}" == "1" ]] || exit 1
  echo "  ALLOW_DIRTY=1 set — proceeding with dirty tree."
fi

IFS=',' read -ra CFG_ARRAY <<< "${CONFIGS}"

echo "============================================================"
echo " Test 1 Local Parallel Runner"
echo " Configs: ${CONFIGS} (${#CFG_ARRAY[@]} parallel jobs)"
echo " Effort:  ${EFFORT_LEVELS}"
echo "============================================================"
echo ""

# Preflight: check Ollama is running (nomic configs need it)
if ! curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "FATAL: Ollama not running (needed for nomic-embed-text). Start with: ollama serve"
  exit 1
fi
echo "Ollama OK"

# Preflight: check AWS creds
aws sts get-caller-identity >/dev/null 2>&1 || { echo "FATAL: No valid AWS credentials"; exit 1; }
echo "AWS OK"
echo ""

mkdir -p results/test1-local-parallel
PIDS=()
LOGS=()

for cfg in "${CFG_ARRAY[@]}"; do
  logfile="results/test1-local-parallel/config-${cfg}-$(date +%Y%m%dT%H%M%S).log"
  echo "Starting Config ${cfg} → ${logfile}"

  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    SHELL="$SHELL" \
    TERM="${TERM:-xterm-256color}" \
    USER="$USER" \
    AWS_REGION=eu-west-2 \
    AWS_DEFAULT_REGION=eu-west-2 \
    bash -c "npx tsx src/test-pipeline-e2e.ts --config '${cfg}' --judge-effort '${EFFORT_LEVELS}'" \
    >"${logfile}" 2>&1 &

  PIDS+=($!)
  LOGS+=("${logfile}")
done

echo ""
echo "${#PIDS[@]} jobs launched. Waiting..."
echo ""

FAILED=0
for i in "${!PIDS[@]}"; do
  pid=${PIDS[$i]}
  cfg=${CFG_ARRAY[$i]}
  log=${LOGS[$i]}

  if wait "$pid"; then
    echo "Config ${cfg} DONE (pid ${pid}) — ${log}"
  else
    echo "Config ${cfg} FAILED (pid ${pid}, exit $?) — ${log}"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "All ${#CFG_ARRAY[@]} configs completed successfully."
else
  echo "${FAILED}/${#CFG_ARRAY[@]} configs failed. Check logs above."
fi

echo ""
echo "Results:"
ls -1t results/pipeline-e2e-*.json 2>/dev/null | head -20
