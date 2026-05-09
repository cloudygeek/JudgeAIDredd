#!/usr/bin/env bash
# PromptArmor Phase B (Anthropic-on-Bedrock subset) entrypoint.
#
# Iterates the cell matrix:
#   AGENT_MODELS   ∈ {sonnet, opus-4-7}                         (--model on the runner)
#   DEFENCES       ∈ {none, B7, B7.1, promptarmor}              (per-cell defence)
#   ATTACKS        ∈ {important_instructions}                   (paper centrepiece)
#   SUITES         ∈ {workspace}                                (default)
#
# Override any of these by exporting the env var with a comma-separated
# list. Empty/unset falls back to the default below.
#
# Required env:
#   AWS_REGION              eu-west-2
#   AWS credentials          via task role / env / SSO chain
#   DREDD_URL               https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal
#   DREDD_API_KEY           Bearer token for /screen and /evaluate when DREDD_AUTH_MODE != off
#
# Optional:
#   RUN_ID                  defaults to phaseB-bedrock-<utc-timestamp>
#   PROMPTARMOR_MODEL       defaults to "eu.anthropic.claude-sonnet-4-6"
#   PROMPTARMOR_BACKEND     defaults to "bedrock"
#   AGENTDOJO_LOGDIR        defaults to /app/runs (in the image)
#   DRY_RUN=1               echo the planned commands, don't execute

set -euo pipefail

log()  { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FATAL: $*" >&2; exit 1; }

# ── Required configuration ─────────────────────────────────────────────────
: "${DREDD_URL:?DREDD_URL must be set}"
: "${AWS_REGION:?AWS_REGION must be set}"

# Sanity probe — capture real diagnostics so an egress block / DNS
# issue surfaces with detail rather than a generic "cannot reach".
# SKIP_HEALTH=1 bypasses the probe entirely (use only when debugging).
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

RUN_ID="${RUN_ID:-phaseB-bedrock-$(date -u '+%Y%m%dT%H%M%SZ')}"
PROMPTARMOR_BACKEND="${PROMPTARMOR_BACKEND:-bedrock}"
PROMPTARMOR_MODEL="${PROMPTARMOR_MODEL:-eu.anthropic.claude-sonnet-4-6}"
AGENT_MODELS="${AGENT_MODELS:-sonnet,opus-4-7}"
DEFENCES="${DEFENCES:-none,B7,B7.1,promptarmor}"
ATTACKS="${ATTACKS:-important_instructions}"
SUITES="${SUITES:-workspace}"
LOGDIR="${AGENTDOJO_LOGDIR:-/app/runs}"

mkdir -p "$LOGDIR"
SUMMARY_LOG="$LOGDIR/${RUN_ID}-summary.log"

# S3 result persistence — when RESULTS_S3_URL is set, every cell
# round-trips through S3 so a redeployed container resumes from where
# the previous one stopped (AgentDojo's default skip-if-result-exists
# logic kicks in once $LOGDIR is hydrated). Without this, every
# container restart re-runs the entire matrix from scratch, including
# already-completed cell-1 trajectories — wasted ~hours of duplicate
# Bedrock spend before this was added.
#
# RESULTS_S3_URL should include the run id so concurrent cells from
# different runs don't trample each other:
#   RESULTS_S3_URL=s3://my-bucket/promptarmor/<RUN_ID>
RESULTS_S3_URL="${RESULTS_S3_URL:-}"

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

# Pull existing results before we plan cells; on a resume this means
# completed trajectories will be skipped by AgentDojo automatically.
s3_pull

log "─── PromptArmor Phase B (Bedrock subset) ────────────────────────"
log "RUN_ID=$RUN_ID"
log "DREDD_URL=$DREDD_URL"
log "AWS_REGION=$AWS_REGION"
log "AGENT_MODELS=$AGENT_MODELS"
log "DEFENCES=$DEFENCES"
log "ATTACKS=$ATTACKS"
log "SUITES=$SUITES"
log "PROMPTARMOR_BACKEND=$PROMPTARMOR_BACKEND  PROMPTARMOR_MODEL=$PROMPTARMOR_MODEL"
log "LOGDIR=$LOGDIR"
log "GIT_COMMIT=${GIT_COMMIT:-unknown}  DRY_RUN=${DRY_RUN:-0}"
log "─────────────────────────────────────────────────────────────────"

IFS=',' read -ra MODELS_ARR    <<< "$AGENT_MODELS"
IFS=',' read -ra DEFENCES_ARR  <<< "$DEFENCES"
IFS=',' read -ra ATTACKS_ARR   <<< "$ATTACKS"
IFS=',' read -ra SUITES_ARR    <<< "$SUITES"

cell=0
total_cells=$(( ${#MODELS_ARR[@]} * ${#DEFENCES_ARR[@]} * ${#ATTACKS_ARR[@]} * ${#SUITES_ARR[@]} ))
log "Cell plan: $total_cells cells (${#MODELS_ARR[@]} models × ${#DEFENCES_ARR[@]} defences × ${#ATTACKS_ARR[@]} attacks × ${#SUITES_ARR[@]} suites)"

run_cell() {
  local model="$1" defence="$2" attack="$3" suite="$4"
  local args=(
    benchmarks/agentdojo/run_benchmark.py
    --backend bedrock
    --model "$model"
    --suite "$suite"
    --attack "$attack"
    --aws-region "$AWS_REGION"
    --dredd-url "$DREDD_URL"
    --logdir "$LOGDIR"
  )
  case "$defence" in
    none)
      ;;
    B7|B7.1|standard)
      args+=(--defense "$defence")
      ;;
    promptarmor)
      args+=(--promptarmor-backend "$PROMPTARMOR_BACKEND")
      args+=(--promptarmor-model "$PROMPTARMOR_MODEL")
      args+=(--promptarmor-run-id "$RUN_ID")
      ;;
    *)
      fail "Unknown defence: $defence (expected: none|B7|B7.1|promptarmor)"
      ;;
  esac

  # AI Sandbox internal ALBs sign with CKO's self-signed CA chain
  # which isn't in the container's trust store. Run-benchmark.py's
  # --promptarmor-no-verify-tls and --promptarmor-api-key flags
  # control both /screen (PromptArmor) and /evaluate (Dredd judge B7/
  # B7.1) — same hook ALB, same auth gate. The dredd_defense.py path
  # silently failed pre-v0.1.314 because it used neither.
  if [[ "$defence" != "none" ]]; then
    args+=(--promptarmor-no-verify-tls)
    if [[ -n "${DREDD_API_KEY:-}" ]]; then
      args+=(--promptarmor-api-key "$DREDD_API_KEY")
    fi
  fi

  cell=$((cell + 1))
  local label="[${cell}/${total_cells}] model=$model defence=$defence attack=$attack suite=$suite"
  log "▶ $label"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "  DRY_RUN: python3 ${args[*]}"
    return 0
  fi

  # Per-cell log so we can grep for failures without losing the
  # aggregate summary in a 22k-line file. Tee to stdout too so the
  # AI Sandbox api-server's log buffer (GET /logs) shows live progress
  # rather than going silent for 30+ minutes per cell. pipefail makes
  # the conditional honour python3's exit code, not tee's.
  local cell_log="$LOGDIR/${RUN_ID}-${model}-${defence}-${attack}-${suite}.log"
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
    # Continue the matrix; one bad cell shouldn't abort the whole run.
  fi

  # Flush per-cell so a container bounce mid-matrix doesn't lose
  # everything completed since startup.
  s3_push
}

for suite in "${SUITES_ARR[@]}"; do
  for attack in "${ATTACKS_ARR[@]}"; do
    for model in "${MODELS_ARR[@]}"; do
      for defence in "${DEFENCES_ARR[@]}"; do
        run_cell "$model" "$defence" "$attack" "$suite"
      done
    done
  done
done

log "─── Summary ─────────────────────────────────────────────────────"
if [[ -f "$SUMMARY_LOG" ]]; then
  cat "$SUMMARY_LOG"
fi
log "─────────────────────────────────────────────────────────────────"

# Final flush so the summary log itself lands in S3.
s3_push

# Exit non-zero if any cell failed so Fargate marks the task as failed.
if grep -q $'\tFAIL' "$SUMMARY_LOG" 2>/dev/null; then
  exit 1
fi
exit 0
