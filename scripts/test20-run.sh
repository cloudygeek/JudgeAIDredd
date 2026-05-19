#!/usr/bin/env bash
# Test 20 — AgentDojo cross-vendor with Qwen3.5/Qwen3.6 (Ollama, M4 Max)
# Sequential four-arm run: Qwen3.5 baseline → Qwen3.5 defended → Qwen3.6 baseline → Qwen3.6 defended.
# Designed to run detached (nohup + caffeinate) for ~30h.
set -o pipefail

cd "$(dirname "$0")/.."

LOGDIR_ROOT="results/test20"
S3_BUCKET="judgeaidredd"
S3_PREFIX="test20"
S3_REGION="eu-west-1"
DREDD_URL="http://localhost:3001"

PYTHON=".venv/bin/python"

mkdir -p "${LOGDIR_ROOT}"
RUN_LOG="${LOGDIR_ROOT}/run.log"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "${RUN_LOG}"
}

s3_sync() {
  aws s3 sync "${LOGDIR_ROOT}/" "s3://${S3_BUCKET}/${S3_PREFIX}/" \
    --region "${S3_REGION}" --quiet 2>&1 | tee -a "${RUN_LOG}" || true
}

run_arm() {
  local model_choice="$1"        # qwen3.5 | qwen3.6
  local arm="$2"                  # baseline | defended-b71
  local model_tag                 # qwen3.5-35b / qwen3.6-35b
  case "${model_choice}" in
    qwen3.5) model_tag="qwen3.5-35b" ;;
    qwen3.6) model_tag="qwen3.6-35b" ;;
    *) log "FATAL: unknown model ${model_choice}"; exit 1 ;;
  esac

  local logdir="${LOGDIR_ROOT}/${model_tag}-${arm}"
  mkdir -p "${logdir}"

  local arm_log="${logdir}/run.log"
  log "START ${model_tag} ${arm} → ${logdir}"

  local defence_args=()
  if [ "${arm}" = "defended-b71" ]; then
    defence_args=(--defense B7.1 --dredd-url "${DREDD_URL}")
  fi

  local arm_start=$(date +%s)

  OPENAI_BASE_URL=http://localhost:11434/v1 \
  OPENAI_API_KEY=ollama-stub \
  "${PYTHON}" benchmarks/agentdojo/run_benchmark.py \
    --backend openai --model "${model_choice}" \
    --attack important_instructions \
    --all-suites \
    "${defence_args[@]}" \
    --logdir "${logdir}" \
    -f \
    >> "${arm_log}" 2>&1 \
    && log "OK    ${model_tag} ${arm} (elapsed=$(( $(date +%s) - arm_start ))s)" \
    || log "WARN  ${model_tag} ${arm} exited with error (elapsed=$(( $(date +%s) - arm_start ))s)"

  # Sync this arm's results to S3
  s3_sync
}

log "================================================================"
log " Test 20 cross-vendor run (Qwen3.5 + Qwen3.6 35B Q4_K_M)"
log " Host: $(uname -m) $(sw_vers -productName) $(sw_vers -productVersion)"
log " Dredd: $(curl -fsS ${DREDD_URL}/health 2>/dev/null | head -c 200)"
log "================================================================"

# Seed S3 with provenance up-front
s3_sync

# Sequential arms
run_arm qwen3.5 baseline
run_arm qwen3.5 defended-b71
run_arm qwen3.6 baseline
run_arm qwen3.6 defended-b71

log "================================================================"
log " Test 20 ALL ARMS COMPLETE"
log "================================================================"

# Final sync
s3_sync
