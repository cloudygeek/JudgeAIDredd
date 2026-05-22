#!/usr/bin/env bash
# MT-AgentRisk benchmark entrypoint (Bedrock-only subset).
#
# Iterates the cell matrix:
#   AGENT_MODELS  ∈ {sonnet-4.6, opus-4-7, gpt-4o-mini, qwen3-32b, qwen3-235b}
#   DEFENCES      ∈ {none, intent-tracker, promptarmor,
#                    intent-tracker+promptarmor}
#                  composite tokens enable both arms simultaneously
#                  (T-5 from docs/tests-needed-2026-05-13.md)
#   SCENARIOS     selector — "all", "N-pilot", or comma-separated IDs
#                            (default "all")
#
# Required env:
#   AWS_REGION              eu-west-2
#   DREDD_URL               https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal
#   DREDD_API_KEY           Bearer key for /screen and /evaluate
#
# Optional:
#   RUN_ID                  defaults to phaseD-mt-agentrisk-<utc>
#   PROMPTARMOR_BACKEND     defaults to "bedrock"
#   PROMPTARMOR_MODEL       defaults to "eu.anthropic.claude-sonnet-4-6"
#   OPENAI_API_KEY          required IF AGENT_MODELS contains a gpt-*
#   AGENT_REGION            override the agent model region
#   MAX_TURNS               defaults to 8
#   RANDOM_SEED             defaults to 42
#   RESULTS_S3_URL          s3://bucket/prefix (round-trips $LOGDIR
#                           through S3 between cells so a redeploy resumes)
#   DRY_RUN=1               echo planned commands, don't execute
#   SKIP_HEALTH=1           bypass the /health probe (debug only)

set -euo pipefail

log()  { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FATAL: $*" >&2; exit 1; }

: "${DREDD_URL:?DREDD_URL must be set}"
: "${AWS_REGION:?AWS_REGION must be set}"

# ── PostgreSQL bootstrap ────────────────────────────────────────────
# MT-AgentRisk's tool_sandbox.reset_for_scenario() shells out to psql
# per scenario to seed the DB, and the postgres MCP server connects
# to localhost:5432. Boot a user-mode postgres against /tmp/pgdata so
# the non-root container user can own the cluster.
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1 || true)"
PGDATA_DIR="${PGDATA_DIR:-/tmp/pgdata}"
PGRUN_DIR="${PGRUN_DIR:-/tmp/pgrun}"
if [[ -n "$PGBIN" ]] && [[ "${SKIP_POSTGRES:-0}" != "1" ]]; then
  export PATH="$PGBIN:$PATH"
  if [[ ! -s "$PGDATA_DIR/PG_VERSION" ]]; then
    log "postgres: initdb -> $PGDATA_DIR (one-time)"
    "$PGBIN/initdb" -D "$PGDATA_DIR" -U postgres --auth=trust >/tmp/initdb.log 2>&1 || {
      log "postgres: initdb failed — see /tmp/initdb.log"
      log "postgres: continuing without DB; postgres scenarios will fail"
    }
  fi
  if [[ -s "$PGDATA_DIR/PG_VERSION" ]]; then
    log "postgres: starting on 127.0.0.1:5432 (data=$PGDATA_DIR socket=$PGRUN_DIR)"
    "$PGBIN/pg_ctl" -D "$PGDATA_DIR" \
        -l /tmp/postgres.log \
        -o "-h 127.0.0.1 -p 5432 -k $PGRUN_DIR" \
        start >/tmp/pgctl.log 2>&1 || {
      log "postgres: pg_ctl start failed — see /tmp/pgctl.log /tmp/postgres.log"
    }
    # Wait up to 15s for the server to accept connections.
    for i in $(seq 1 30); do
      if "$PGBIN/pg_isready" -h 127.0.0.1 -p 5432 -U postgres -q; then
        log "postgres: ready ($i/30)"
        # Set the password the runner uses (PGPASSWORD=password from
        # tool_sandbox.py:75). With auth=trust the password is ignored
        # for local connections, but set it anyway for parity with the
        # MCP server's connection string.
        "$PGBIN/psql" -h 127.0.0.1 -U postgres -d postgres \
            -c "ALTER USER postgres WITH PASSWORD 'password';" >/dev/null 2>&1 || true
        break
      fi
      sleep 0.5
    done
    if ! "$PGBIN/pg_isready" -h 127.0.0.1 -p 5432 -U postgres -q; then
      log "postgres: NOT ready after 15s — postgres scenarios will fail"
    fi
  fi
else
  log "postgres: skipped (SKIP_POSTGRES=$SKIP_POSTGRES, PGBIN='$PGBIN')"
fi

# Sanity probe — same shape as the bedt3/4/5 entrypoints.
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

RUN_ID="${RUN_ID:-phaseD-mt-agentrisk-$(date -u '+%Y%m%dT%H%M%SZ')}"
PROMPTARMOR_BACKEND="${PROMPTARMOR_BACKEND:-bedrock}"
PROMPTARMOR_MODEL="${PROMPTARMOR_MODEL:-eu.anthropic.claude-sonnet-4-6}"
AGENT_MODELS="${AGENT_MODELS:-sonnet-4.6}"
DEFENCES="${DEFENCES:-none,intent-tracker}"
SCENARIOS="${SCENARIOS:-all}"
MAX_TURNS="${MAX_TURNS:-8}"
RANDOM_SEED="${RANDOM_SEED:-42}"
LOGDIR="${MT_AGENTRISK_LOGDIR:-/app/runs}"

mkdir -p "$LOGDIR"
SUMMARY_LOG="$LOGDIR/${RUN_ID}-summary.log"

RESULTS_S3_URL="${RESULTS_S3_URL:-s3://cko-results/mt-agentrisk/${RUN_ID}}"
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

log "─── MT-AgentRisk × Judge AI Dredd ────────────────────────────────"
log "RUN_ID=$RUN_ID"
log "DREDD_URL=$DREDD_URL"
log "AWS_REGION=$AWS_REGION"
log "AGENT_MODELS=$AGENT_MODELS"
log "DEFENCES=$DEFENCES"
log "SCENARIOS=$SCENARIOS"
log "MAX_TURNS=$MAX_TURNS"
log "PROMPTARMOR_BACKEND=$PROMPTARMOR_BACKEND  PROMPTARMOR_MODEL=$PROMPTARMOR_MODEL"
log "LOGDIR=$LOGDIR  RESULTS_S3_URL=${RESULTS_S3_URL:-(none)}"
log "GIT_COMMIT=${GIT_COMMIT:-unknown}  DRY_RUN=${DRY_RUN:-0}"
log "─────────────────────────────────────────────────────────────────"

IFS=',' read -ra MODELS_ARR    <<< "$AGENT_MODELS"
IFS=',' read -ra DEFENCES_ARR  <<< "$DEFENCES"

cell=0
total_cells=$(( ${#MODELS_ARR[@]} * ${#DEFENCES_ARR[@]} ))
log "Cell plan: $total_cells cells (${#MODELS_ARR[@]} models × ${#DEFENCES_ARR[@]} defences)"

# The MT-AgentRisk runner walks all defences for a single model in one
# Python invocation (--defences=$d1,$d2,...). We split per-defence so
# each cell gets its own log file (matches the InjecAgent + AgentDojo
# pattern; preserves cell isolation if one cell crashes).

run_cell() {
  local model="$1" defence="$2"

  local args=(
    -m benchmarks.mt_agentrisk.run_benchmark
    --models "$model"
    --scenarios "$SCENARIOS"
    --defences "$defence"
    --max-turns "$MAX_TURNS"
    --dredd-url "$DREDD_URL"
    --random-seed "$RANDOM_SEED"
    --output-dir "$LOGDIR/${model}-${defence}"
  )
  if [[ -n "${AGENT_REGION:-}" ]]; then
    args+=(--agent-region "$AGENT_REGION")
  fi

  # PromptArmor flags fire when the defence string contains
  # "promptarmor" (either standalone or composite). The runner's
  # main() validates that --promptarmor-backend + --promptarmor-model
  # are both set whenever a PA-using defence is requested.
  if [[ "$defence" == *promptarmor* ]]; then
    args+=(--promptarmor-backend "$PROMPTARMOR_BACKEND")
    args+=(--promptarmor-model "$PROMPTARMOR_MODEL")
    args+=(--promptarmor-run-id "$RUN_ID")
  fi
  # Dredd-using cells (intent-tracker, intent-tracker+promptarmor) AND
  # PromptArmor cells share the --promptarmor-{api-key,no-verify-tls}
  # flags — they control auth + TLS for the same hook ALB regardless
  # of which defence is in play. Without these, intent-tracker cells
  # SSL-fail (self-signed CA) or 401-fail every /intent + /evaluate
  # call, fail-open silently, and report bare-agent ASR with a
  # defence label. (bedt5 mt-agentrisk 2026-05-20: 7h of broken
  # telemetry from this exact bug.)
  if [[ "$defence" != "none" ]]; then
    args+=(--promptarmor-no-verify-tls)
    if [[ -n "${DREDD_API_KEY:-}" ]]; then
      args+=(--promptarmor-api-key "$DREDD_API_KEY")
    fi
  fi

  cell=$((cell + 1))
  local label="[${cell}/${total_cells}] model=$model defence=$defence"
  log "▶ $label"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "  DRY_RUN: python3 ${args[*]}"
    return 0
  fi

  local cell_log="$LOGDIR/${RUN_ID}-${model}-${defence}.log"
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

for model in "${MODELS_ARR[@]}"; do
  for defence in "${DEFENCES_ARR[@]}"; do
    run_cell "$model" "$defence"
  done
done

log "─── Summary ─────────────────────────────────────────────────────"
cat "$SUMMARY_LOG" 2>/dev/null || true
log "─────────────────────────────────────────────────────────────────"

s3_push
