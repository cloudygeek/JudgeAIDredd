#!/usr/bin/env bash
# Test-framework entrypoint — drives the P15 T3 goal-hijacking
# scenarios via the Claude Agent SDK (Node), with optional
# observational PromptArmor screening (T-2 Path C).
#
# Iterates the cell matrix:
#   AGENT_MODELS  ∈ {sonnet, opus-4-7, gpt-4o-mini, qwen3-32b, qwen3-235b}
#                  Translated to model ids the CLI accepts (Bedrock
#                  inference profile ids when CLAUDE_CODE_USE_BEDROCK=1).
#   DEFENCES      ∈ {none, intent-tracker, drift-only, anchor-only,
#                    promptarmor-obs}
#                  promptarmor-obs is observational only — Path C
#                  per the T-0 probe (the SDK's PostToolUse hook
#                  doesn't rewrite built-in tool outputs, so we
#                  measure detection, not enforcement).
#   SCENARIOS     ∈ {naive, intermediate, sophisticated, all}
#   REPETITIONS   defaults to 1
#
# Required env:
#   AWS_REGION              eu-west-2 (used by Bedrock when
#                                       CLAUDE_CODE_USE_BEDROCK=1)
#   DREDD_URL               https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal
#                           (only consulted by promptarmor-obs)
#   DREDD_API_KEY           Bearer key for /screen
#
# Optional:
#   RUN_ID                  defaults to phaseD-test-framework-<utc>
#   PROMPTARMOR_BACKEND     defaults to "bedrock"
#   PROMPTARMOR_MODEL       defaults to "eu.anthropic.claude-sonnet-4-6"
#   ANTHROPIC_API_KEY       use Anthropic direct API instead of
#                           Bedrock — set this AND unset
#                           CLAUDE_CODE_USE_BEDROCK to switch.
#   RESULTS_S3_URL          s3://bucket/prefix
#   DRY_RUN=1               echo planned commands, don't execute
#   SKIP_HEALTH=1           bypass the /health probe

set -euo pipefail

log()  { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FATAL: $*" >&2; exit 1; }

: "${AWS_REGION:?AWS_REGION must be set (Bedrock region for the agent)}"

# Health probe is only meaningful for promptarmor-obs cells (which
# call /screen). Skip otherwise — but check unconditionally if the
# operator set DREDD_URL anyway.
if [[ -n "${DREDD_URL:-}" && "${SKIP_HEALTH:-0}" != "1" ]]; then
  log "Hook health probe: ${DREDD_URL%/}/health"
  probe_rc=0
  probe_output=$(curl -sk --max-time 10 -o /tmp/health-body \
    -w 'http_code=%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s total=%{time_total}s remote=%{remote_ip}:%{remote_port}' \
    "${DREDD_URL%/}/health" 2>&1) || probe_rc=$?
  log "  probe: ${probe_output:-(no output)} curl_rc=$probe_rc"
  log "  body:  $(head -c 200 /tmp/health-body 2>/dev/null || echo '(empty)')"
  if [[ "$probe_rc" != "0" ]] || ! head -c 200 /tmp/health-body 2>/dev/null | grep -q '"status":"ok"'; then
    log "WARN: Hook /health probe failed — promptarmor-obs cells will fail-open."
  fi
fi

RUN_ID="${RUN_ID:-phaseD-test-framework-$(date -u '+%Y%m%dT%H%M%SZ')}"
PROMPTARMOR_BACKEND="${PROMPTARMOR_BACKEND:-bedrock}"
PROMPTARMOR_MODEL="${PROMPTARMOR_MODEL:-eu.anthropic.claude-sonnet-4-6}"
AGENT_MODELS="${AGENT_MODELS:-sonnet}"
DEFENCES="${DEFENCES:-none,intent-tracker}"
SCENARIOS="${SCENARIOS:-all}"
REPETITIONS="${REPETITIONS:-1}"
LOGDIR="${TEST_FRAMEWORK_LOGDIR:-/app/runs}"

mkdir -p "$LOGDIR"
SUMMARY_LOG="$LOGDIR/${RUN_ID}-summary.log"

RESULTS_S3_URL="${RESULTS_S3_URL:-s3://cko-results/test-framework/${RUN_ID}}"
if [[ "${RESULTS_S3_DISABLE:-0}" == "1" ]]; then
  RESULTS_S3_URL=""
fi
# Lightweight S3 helpers (this image is Node-based and doesn't have
# the python s3_sync.py from the other images; use aws CLI if
# present, otherwise skip).
s3_push() {
  if [[ -z "$RESULTS_S3_URL" ]]; then return 0; fi
  if ! command -v aws >/dev/null 2>&1; then
    log "s3_sync: aws CLI not installed — skipping push (results stay local)"
    return 0
  fi
  local push_rc=0
  aws s3 sync "$LOGDIR/" "$RESULTS_S3_URL/" --no-progress || push_rc=$?
  if [[ "$push_rc" == "0" ]]; then
    # Clean the run dir after a SUCCESSFUL upload — the container reuses
    # $LOGDIR across runs and would otherwise re-sync stale cells into the
    # next run's prefix (shared-bucket contamination). Only on rc==0.
    log "s3_sync: push OK — cleaning $LOGDIR for the next run"
    rm -rf "${LOGDIR:?}"/* 2>/dev/null || true
  else
    log "s3_sync: push failed (rc=$push_rc) — results stay local, NOT cleaning"
  fi
}

# Map AGENT_MODELS tokens to the model ids the Claude CLI accepts.
# Bedrock inference profile ids when CLAUDE_CODE_USE_BEDROCK=1;
# Anthropic-direct ids otherwise.
resolve_model() {
  local token="$1"
  if [[ "${CLAUDE_CODE_USE_BEDROCK:-0}" == "1" ]]; then
    case "$token" in
      sonnet|sonnet-4-6) echo "eu.anthropic.claude-sonnet-4-6" ;;
      opus-4-7|opus)     echo "eu.anthropic.claude-opus-4-7" ;;
      haiku-4-5|haiku)   echo "eu.anthropic.claude-haiku-4-5-20251001-v1:0" ;;
      *) echo "$token" ;;  # pass through verbatim
    esac
  else
    case "$token" in
      sonnet|sonnet-4-6) echo "claude-sonnet-4-6" ;;
      opus-4-7|opus)     echo "claude-opus-4-7" ;;
      haiku-4-5|haiku)   echo "claude-haiku-4-5-20251001" ;;
      *) echo "$token" ;;
    esac
  fi
}

log "─── P15 Test-Framework × Judge AI Dredd ────────────────────────"
log "RUN_ID=$RUN_ID"
log "DREDD_URL=${DREDD_URL:-(none)}"
log "AWS_REGION=$AWS_REGION  CLAUDE_CODE_USE_BEDROCK=${CLAUDE_CODE_USE_BEDROCK:-0}"
log "AGENT_MODELS=$AGENT_MODELS"
log "DEFENCES=$DEFENCES"
log "SCENARIOS=$SCENARIOS"
log "REPETITIONS=$REPETITIONS"
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
  local model_token="$1" defence="$2"
  local model_id; model_id=$(resolve_model "$model_token")

  local args=(
    src/runner.ts
    --model "$model_id"
    --scenario "$SCENARIOS"
    --repetitions "$REPETITIONS"
    --defence "$defence"
  )

  # Defences other than `none` and `promptarmor-obs` use IntentTracker,
  # which historically needed an Ollama daemon (nomic-embed-text +
  # llama3.2). The Fargate image has no Ollama; pass --backend=bedrock
  # so layer 1 uses Cohere embed-v4 and layer 2 uses Claude Sonnet 4.6
  # via Bedrock. Operator can opt out via INTENT_BACKEND=ollama.
  case "$defence" in
    intent-tracker|drift-only|anchor-only)
      args+=(--backend "${INTENT_BACKEND:-bedrock}")
      ;;
  esac

  # Output goes to a per-cell file so cells stay isolated. The
  # runner writes JSON; we capture stdout/stderr to a separate log
  # for human consumption.
  local safe_id="${model_token//\//_}-${defence}"
  local out_json="$LOGDIR/results-${safe_id}-${RUN_ID}.json"
  args+=(--output "$out_json")

  if [[ "$defence" == "promptarmor-obs" ]]; then
    if [[ -z "${DREDD_URL:-}" ]]; then
      fail "DEFENCES=$defence requires DREDD_URL"
    fi
    args+=(--promptarmor-url "$DREDD_URL")
    args+=(--promptarmor-backend "$PROMPTARMOR_BACKEND")
    args+=(--promptarmor-model "$PROMPTARMOR_MODEL")
    args+=(--promptarmor-run-id "$RUN_ID")
    args+=(--promptarmor-insecure)
    if [[ -n "${DREDD_API_KEY:-}" ]]; then
      args+=(--promptarmor-api-key "$DREDD_API_KEY")
    fi
  fi

  cell=$((cell + 1))
  local label="[${cell}/${total_cells}] model=$model_token ($model_id) defence=$defence"
  log "▶ $label"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "  DRY_RUN: cd test-framework && npx tsx ${args[*]}"
    return 0
  fi

  local cell_log="$LOGDIR/${RUN_ID}-${safe_id}.log"
  local start_ts; start_ts=$(date +%s)
  set -o pipefail
  # Invoke tsx's cli.mjs directly. We can't rely on `npx tsx` or
  # `node_modules/.bin/tsx` because the build script strips the
  # symlink-laden .bin directory (zip+unzip don't preserve symlinks
  # reliably enough through the AI Sandbox CodeBuild pipeline).
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
