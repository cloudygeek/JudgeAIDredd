#!/usr/bin/env bash
# InjecAgent Phase B (Bedrock subset) entrypoint.
#
# Iterates the cell matrix:
#   AGENT_MODELS  ∈ {sonnet, opus-4-7, gpt-4o-mini, qwen3-32b, qwen3-235b}
#   DEFENCES      ∈ {none, promptarmor, B7, B7.1,
#                    B7+promptarmor, B7.1+promptarmor}
#                  composite tokens enable both arms simultaneously
#                  (the runner pipeline screens Tool Response with
#                  PromptArmor AND post-judges the resulting tool
#                  call via Dredd) — used for the T-5 defence-in-depth
#                  cell from docs/tests-needed-2026-05-13.md
#   SETTINGS      ∈ {base, enhanced}         (base is the default benchmark protocol)
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
#   OPENAI_API_KEY          required IF AGENT_MODELS contains a gpt-*
#                           entry. Pass via the kick-off curl env vars;
#                           the entrypoint forwards it to the runner.
#                           Not stored in Secrets Manager.
#   AGENT_BACKEND           override the default "bedrock" routing if the
#                           gpt-* heuristic doesn't match (rare).
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
  # Route to the OpenAI branch when the model is GPT-family. Bare model
  # ids (no dot) are OpenAI; vendor-prefixed ids (eu.anthropic.*, qwen.*)
  # are Bedrock. AGENT_BACKEND overrides if needed.
  local backend="${AGENT_BACKEND:-bedrock}"
  case "$model" in
    gpt-*) backend="openai" ;;
  esac
  local args=(
    benchmarks/injecagent/run_benchmark.py
    --backend "$backend"
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
    B7|B7.1)
      # Dredd post-output judge: PromptArmor-style preprocessing not
      # done; we let the model see the raw Tool Response, then judge
      # the resulting tool call via /evaluate. Same auth + TLS skip
      # as the AgentDojo container's B7/B7.1 cells. Autonomous mode
      # is the right benchmark config — see the AgentDojo entrypoint
      # for the rationale.
      args+=(--dredd-defense "$defence")
      args+=(--dredd-mode "${DREDD_MODE:-autonomous}")
      args+=(--promptarmor-no-verify-tls)
      if [[ -n "${DREDD_API_KEY:-}" ]]; then
        args+=(--promptarmor-api-key "$DREDD_API_KEY")
      fi
      ;;
    B7+promptarmor|B7.1+promptarmor)
      # Composite arm — both PromptArmor pre-screen on tool response AND
      # Dredd post-output judge on the resulting tool call. Tests
      # whether the failure modes are orthogonal (T-5 in
      # docs/tests-needed-2026-05-13.md). The runner pipeline already
      # supports both being active simultaneously: PromptArmor mutates
      # Tool Response (line ~478), model runs, Dredd judges the
      # resulting tool call (line ~512). Output suffix becomes
      # `-promptarmor+dredd-B7.1`.
      local dredd_variant="${defence%+promptarmor}"
      args+=(--promptarmor-backend "$PROMPTARMOR_BACKEND")
      args+=(--promptarmor-model "$PROMPTARMOR_MODEL")
      args+=(--promptarmor-run-id "$RUN_ID")
      args+=(--dredd-defense "$dredd_variant")
      args+=(--dredd-mode "${DREDD_MODE:-autonomous}")
      args+=(--promptarmor-no-verify-tls)
      if [[ -n "${DREDD_API_KEY:-}" ]]; then
        args+=(--promptarmor-api-key "$DREDD_API_KEY")
      fi
      ;;
    *)
      fail "Unknown defence: $defence (expected: none|promptarmor|B7|B7.1|B7+promptarmor|B7.1+promptarmor)"
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
