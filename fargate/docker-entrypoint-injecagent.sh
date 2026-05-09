#!/usr/bin/env bash
# InjecAgent Phase B (Bedrock subset) entrypoint.
#
# Iterates the cell matrix:
#   AGENT_MODELS  ∈ {sonnet, opus-4-7}
#   DEFENCES      ∈ {none, promptarmor}      (B7/B7.1 deferred — InjecAgent
#                                             has no PreToolUse gate to
#                                             plug them into; the test
#                                             plan §B5 calls for "our
#                                             defence and PromptArmor only"
#                                             on InjecAgent)
#   SETTINGS      ∈ {base}                   (enhanced is harder; defer)
#   ATTACKS       ∈ {dh, ds}                 (single token; runner takes
#                                             both as a comma-list)
#
# Required env (same as the bedt3/4 container):
#   AWS_REGION              eu-west-2
#   DREDD_URL               https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal
#   DREDD_API_KEY           Bearer key for /screen
#
# Optional:
#   RUN_ID                  defaults to phaseB-injecagent-<utc>
#   PROMPTARMOR_MODEL       defaults to "eu.anthropic.claude-sonnet-4-6"
#   PROMPTARMOR_BACKEND     defaults to "bedrock"
#   AGENTDOJO_LOGDIR        defaults to /app/runs (kept name-compatible
#                           with the bedt3/4 entrypoint so monitoring
#                           tooling can grep the same paths)
#   RESULTS_S3_URL          s3://bucket/prefix — round-trips $LOGDIR
#                           through S3 between cells so a redeploy resumes
#   DRY_RUN=1               echo planned commands, don't execute
#   SKIP_HEALTH=1           bypass the /health probe (debug only)

set -euo pipefail

log()  { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FATAL: $*" >&2; exit 1; }

: "${DREDD_URL:?DREDD_URL must be set}"
: "${AWS_REGION:?AWS_REGION must be set}"

# Sanity probe — same shape as the bedt3/4 entrypoint so failures
# surface with the same diagnostics.
if [[ "${SKIP_HEALTH:-0}" != "1" ]]; then
  log "Hook health probe: ${DREDD_URL%/}/health"
  probe_rc=0
  probe_output=$(curl -sk --max-time 10 -o /tmp/health-body \
    -w 'http_code=%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s total=%{time_total}s remote=%{remote_ip}:%{remote_port}' \
    "${DREDD_URL%/}/health" 2>&1) || probe_rc=$?
  log "  probe: ${probe_output:-(no output)} curl_rc=$probe_rc"
  log "  body:  $(head -c 200 /tmp/health-body 2>/dev/null || echo '(empty)')"
  if [[ "$probe_rc" != "0" ]] || ! head -c 200 /tmp/health-body 2>/dev/null | grep -q '"status":"ok"'; then
    fail "Hook /health probe failed — see diagnostics above. Set SKIP_HEALTH=1 to bypass."
  fi
fi

RUN_ID="${RUN_ID:-phaseB-injecagent-$(date -u '+%Y%m%dT%H%M%SZ')}"
PROMPTARMOR_BACKEND="${PROMPTARMOR_BACKEND:-bedrock}"
PROMPTARMOR_MODEL="${PROMPTARMOR_MODEL:-eu.anthropic.claude-sonnet-4-6}"
AGENT_MODELS="${AGENT_MODELS:-sonnet,opus-4-7}"
DEFENCES="${DEFENCES:-none,promptarmor}"
SETTINGS="${SETTINGS:-base}"
ATTACKS="${ATTACKS:-dh,ds}"
LOGDIR="${AGENTDOJO_LOGDIR:-/app/runs}"

mkdir -p "$LOGDIR"
SUMMARY_LOG="$LOGDIR/${RUN_ID}-summary.log"

# Default to the standard CKO results bucket. Operator can override
# by passing RESULTS_S3_URL explicitly, or set RESULTS_S3_DISABLE=1
# to opt out entirely.
RESULTS_S3_URL="${RESULTS_S3_URL:-s3://cko-results/injecagent/${RUN_ID}}"
if [[ "${RESULTS_S3_DISABLE:-0}" == "1" ]]; then
  RESULTS_S3_URL=""
fi
s3_pull() {
  if [[ -z "$RESULTS_S3_URL" ]]; then return 0; fi
  log "s3_sync: pulling ${RESULTS_S3_URL}/ -> ${LOGDIR}/"
  python3 /app/benchmarks/agentdojo/s3_sync.py pull "$RESULTS_S3_URL" "$LOGDIR" \
    || log "s3_sync: pull failed (continuing — cells will start fresh)"
}
s3_push() {
  if [[ -z "$RESULTS_S3_URL" ]]; then return 0; fi
  python3 /app/benchmarks/agentdojo/s3_sync.py push "$LOGDIR" "$RESULTS_S3_URL" \
    || log "s3_sync: push failed (results stay local — risk if container is bounced)"
}

s3_pull

log "─── InjecAgent Phase B (Bedrock subset) ─────────────────────────"
log "RUN_ID=$RUN_ID"
log "DREDD_URL=$DREDD_URL"
log "AWS_REGION=$AWS_REGION"
log "AGENT_MODELS=$AGENT_MODELS"
log "DEFENCES=$DEFENCES"
log "SETTINGS=$SETTINGS"
log "ATTACKS=$ATTACKS"
log "PROMPTARMOR_BACKEND=$PROMPTARMOR_BACKEND  PROMPTARMOR_MODEL=$PROMPTARMOR_MODEL"
log "LOGDIR=$LOGDIR  RESULTS_S3_URL=${RESULTS_S3_URL:-(none)}"
log "GIT_COMMIT=${GIT_COMMIT:-unknown}  DRY_RUN=${DRY_RUN:-0}"
log "─────────────────────────────────────────────────────────────────"

IFS=',' read -ra MODELS_ARR    <<< "$AGENT_MODELS"
IFS=',' read -ra DEFENCES_ARR  <<< "$DEFENCES"
IFS=',' read -ra SETTINGS_ARR  <<< "$SETTINGS"

cell=0
total_cells=$(( ${#MODELS_ARR[@]} * ${#DEFENCES_ARR[@]} * ${#SETTINGS_ARR[@]} ))
log "Cell plan: $total_cells cells (${#MODELS_ARR[@]} models × ${#DEFENCES_ARR[@]} defences × ${#SETTINGS_ARR[@]} settings)"

run_cell() {
  local model="$1" defence="$2" setting="$3"
  local args=(
    benchmarks/injecagent/run_benchmark.py
    --backend bedrock
    --model "$model"
    --setting "$setting"
    --attacks "$ATTACKS"
    --aws-region "$AWS_REGION"
    --dredd-url "$DREDD_URL"
    --logdir "$LOGDIR"
  )
  case "$defence" in
    none)
      ;;
    promptarmor)
      args+=(--promptarmor-backend "$PROMPTARMOR_BACKEND")
      args+=(--promptarmor-model "$PROMPTARMOR_MODEL")
      args+=(--promptarmor-run-id "$RUN_ID")
      args+=(--promptarmor-no-verify-tls)
      if [[ -n "${DREDD_API_KEY:-}" ]]; then
        args+=(--promptarmor-api-key "$DREDD_API_KEY")
      fi
      ;;
    *)
      fail "Unknown defence: $defence (expected: none|promptarmor)"
      ;;
  esac

  cell=$((cell + 1))
  local label="[${cell}/${total_cells}] model=$model defence=$defence setting=$setting"
  log "▶ $label"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "  DRY_RUN: python3 ${args[*]}"
    return 0
  fi

  local cell_log="$LOGDIR/${RUN_ID}-${model}-${defence}-${setting}.log"
  local start_ts; start_ts=$(date +%s)
  set -o pipefail
  if python3 "${args[@]}" 2>&1 | tee "$cell_log"; then
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

for setting in "${SETTINGS_ARR[@]}"; do
  for model in "${MODELS_ARR[@]}"; do
    for defence in "${DEFENCES_ARR[@]}"; do
      run_cell "$model" "$defence" "$setting"
    done
  done
done

log "─── Summary ─────────────────────────────────────────────────────"
if [[ -f "$SUMMARY_LOG" ]]; then
  cat "$SUMMARY_LOG"
fi
log "─────────────────────────────────────────────────────────────────"

s3_push

if grep -q $'\tFAIL' "$SUMMARY_LOG" 2>/dev/null; then
  exit 1
fi
exit 0
