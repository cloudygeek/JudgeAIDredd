#!/usr/bin/env bash
# AgentLAB Smoke runner — for T-8 (PromptArmor head-to-head on the
# AgentLAB long-horizon corpus). Drives test-framework/src/runner-
# agentlab.ts which uses the built-in fallback scenarios (5 attack
# types × 10 environments per cell, no AgentLAB Python package
# needed at runtime).
#
# Cell matrix:
#   AGENT_MODELS  ∈ {claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-7,
#                    qwen3-32b, qwen3-235b, qwen3-coder-30b, gpt-4o-mini}
#                  Five-backend slate by default.
#   DEFENCES      ∈ {none, intent-tracker, promptarmor}
#                  promptarmor route runs the new T-8 adapter:
#                  every tool output is screened through /screen and
#                  sanitised content replaces the original (prevention,
#                  not the test-framework's observation-only adapter).
#   ATTACK_TYPES  ∈ {intent_hijacking, tool_chaining, task_injection,
#                    objective_drifting, memory_poisoning}
#   SCENARIOS_PER_TYPE  ≥ 1 (controls SCENARIO_MODE pin; smoke = 2)
#
# Required env:
#   AWS_REGION        eu-west-2 (Bedrock region for the agent)
#   DREDD_URL         https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal
#   DREDD_API_KEY     Bearer key (required when promptarmor is in DEFENCES)
#
# Optional:
#   RUN_ID            defaults to phaseE-agentlab-<utc>
#   PROMPTARMOR_BACKEND  defaults to "bedrock"
#   PROMPTARMOR_MODEL    defaults to "eu.anthropic.claude-sonnet-4-6"
#   RESULTS_S3_URL    s3://bucket/prefix
#   DRY_RUN=1
#   SKIP_HEALTH=1

set -euo pipefail

log()  { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FATAL: $*" >&2; exit 1; }

: "${AWS_REGION:?AWS_REGION must be set}"

if [[ -n "${DREDD_URL:-}" && "${SKIP_HEALTH:-0}" != "1" ]]; then
  log "Hook health probe: ${DREDD_URL%/}/health"
  probe_rc=0
  probe_output=$(curl -sk --max-time 10 -o /tmp/health-body \
    -w 'http_code=%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s total=%{time_total}s remote=%{remote_ip}:%{remote_port}' \
    "${DREDD_URL%/}/health" 2>&1) || probe_rc=$?
  log "  probe: ${probe_output:-(no output)} curl_rc=$probe_rc"
  log "  body:  $(head -c 200 /tmp/health-body 2>/dev/null || echo '(empty)')"
  if [[ "$probe_rc" != "0" ]] || ! head -c 200 /tmp/health-body 2>/dev/null | grep -q '"status":"ok"'; then
    log "WARN: Hook /health probe failed — promptarmor cells will fail-open."
  fi
fi

RUN_ID="${RUN_ID:-phaseE-agentlab-$(date -u '+%Y%m%dT%H%M%SZ')}"
PROMPTARMOR_BACKEND="${PROMPTARMOR_BACKEND:-bedrock}"
PROMPTARMOR_MODEL="${PROMPTARMOR_MODEL:-eu.anthropic.claude-sonnet-4-6}"
AGENT_MODELS="${AGENT_MODELS:-claude-sonnet-4-6}"
DEFENCES="${DEFENCES:-none,intent-tracker,promptarmor}"
ATTACK_TYPES="${ATTACK_TYPES:-intent_hijacking,tool_chaining,task_injection,objective_drifting,memory_poisoning}"
SCENARIO_MODE="${SCENARIO_MODE:-stratified-10}"
RANDOM_SEED="${RANDOM_SEED:-27}"
MAX_TURNS="${MAX_TURNS:-8}"
LOGDIR="${TEST_FRAMEWORK_LOGDIR:-/app/runs}"

mkdir -p "$LOGDIR"
SUMMARY_LOG="$LOGDIR/${RUN_ID}-summary.log"

RESULTS_S3_URL="${RESULTS_S3_URL:-s3://cko-results/agentlab/${RUN_ID}}"
if [[ "${RESULTS_S3_DISABLE:-0}" == "1" ]]; then
  RESULTS_S3_URL=""
fi
s3_push() {
  if [[ -z "$RESULTS_S3_URL" ]]; then return 0; fi
  if ! command -v aws >/dev/null 2>&1; then
    log "s3_sync: aws CLI not installed — skipping push"
    return 0
  fi
  aws s3 sync "$LOGDIR/" "$RESULTS_S3_URL/" --no-progress \
    || log "s3_sync: push failed (results stay local)"
}

log "─── AgentLAB Smoke × Judge AI Dredd ─────────────────────────────"
log "RUN_ID=$RUN_ID"
log "DREDD_URL=${DREDD_URL:-(none)}"
log "AWS_REGION=$AWS_REGION  CLAUDE_CODE_USE_BEDROCK=${CLAUDE_CODE_USE_BEDROCK:-0}"
log "AGENT_MODELS=$AGENT_MODELS"
log "DEFENCES=$DEFENCES"
log "ATTACK_TYPES=$ATTACK_TYPES"
log "SCENARIO_MODE=$SCENARIO_MODE  RANDOM_SEED=$RANDOM_SEED  MAX_TURNS=$MAX_TURNS"
log "PROMPTARMOR_BACKEND=$PROMPTARMOR_BACKEND  PROMPTARMOR_MODEL=$PROMPTARMOR_MODEL"
log "LOGDIR=$LOGDIR  RESULTS_S3_URL=${RESULTS_S3_URL:-(none)}"
log "GIT_COMMIT=${GIT_COMMIT:-unknown}  DRY_RUN=${DRY_RUN:-0}"
log "─────────────────────────────────────────────────────────────────"

IFS=',' read -ra MODELS_ARR    <<< "$AGENT_MODELS"
IFS=',' read -ra DEFENCES_ARR  <<< "$DEFENCES"

cell=0
total_cells=$(( ${#MODELS_ARR[@]} * ${#DEFENCES_ARR[@]} ))
log "Cell plan: $total_cells cells (${#MODELS_ARR[@]} models × ${#DEFENCES_ARR[@]} defences)"

run_cell() {
  local model="$1" defence="$2"
  local out_subdir="$LOGDIR/${RUN_ID}-${model}-${defence}"
  mkdir -p "$out_subdir"

  local args=(
    src/runner-agentlab.ts
    --models "$model"
    --defences "$defence"
    --attack-types "$ATTACK_TYPES"
    --scenarios "$SCENARIO_MODE"
    --random-seed "$RANDOM_SEED"
    --max-turns "$MAX_TURNS"
    --output-dir "$out_subdir"
  )

  if [[ "$defence" == "promptarmor" ]]; then
    if [[ -z "${DREDD_URL:-}" ]]; then
      fail "DEFENCES=$defence requires DREDD_URL"
    fi
    args+=(--promptarmor-url "$DREDD_URL")
    args+=(--promptarmor-backend "$PROMPTARMOR_BACKEND")
    args+=(--promptarmor-model "$PROMPTARMOR_MODEL")
    args+=(--promptarmor-run-id "$RUN_ID")
    args+=(--promptarmor-no-verify-tls)
    if [[ -n "${DREDD_API_KEY:-}" ]]; then
      args+=(--promptarmor-api-key "$DREDD_API_KEY")
    fi
  fi

  cell=$((cell + 1))
  local label="[${cell}/${total_cells}] model=$model defence=$defence"
  log "▶ $label"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "  DRY_RUN: cd test-framework && node node_modules/tsx/dist/cli.mjs ${args[*]}"
    return 0
  fi

  local cell_log="$LOGDIR/${RUN_ID}-${model}-${defence}.log"
  local start_ts; start_ts=$(date +%s)
  set -o pipefail
  if ( cd /app/test-framework && node node_modules/tsx/dist/cli.mjs "${args[@]}" ) 2>&1 | tee "$cell_log"; then
    set +o pipefail
    local elapsed=$(( $(date +%s) - start_ts ))
    log "  ✓ $label (${elapsed}s) → $cell_log"
    printf '%s\tOK\t%s\n' "$label" "$elapsed" >>"$SUMMARY_LOG"
  else
    local rc=$?
    set +o pipefail
    local elapsed=$(( $(date +%s) - start_ts ))
    log "  ✗ $label exited $rc (${elapsed}s) — see $cell_log"
    printf '%s\tFAIL(%s)\t%s\n' "$label" "$rc" "$elapsed" >>"$SUMMARY_LOG"
  fi
  s3_push
}

for model in "${MODELS_ARR[@]}"; do
  for defence in "${DEFENCES_ARR[@]}"; do
    run_cell "$model" "$defence"
  done
done

log "─── Summary ─────────────────────────────────────────────────────"
cat "$SUMMARY_LOG" 2>/dev/null || true
log "─────────────────────────────────────────────────────────────────"

s3_push
