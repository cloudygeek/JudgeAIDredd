#!/usr/bin/env bash
set -euo pipefail

# Judge AI Dredd — HOOK role entrypoint
#
# Baked into the hook-role zip. DREDD_ROLE defaults to "hook" so the
# task definition doesn't need to set it. A platform override can still
# force a different role by setting DREDD_ROLE explicitly.
#
# Identical to docker-entrypoint-dashboard.sh except for the role default.
#
# All configuration via environment variables:
#   MODE              interactive|autonomous|learn  (default: interactive)
#   BACKEND           bedrock|ollama                (default: bedrock)
#   JUDGE_MODEL       model id                      (default: eu.anthropic.claude-sonnet-4-6)
#   EMBEDDING_MODEL   model id                      (default: eu.cohere.embed-v4:0)
#   HARDENED          prompt variant: B7|B7.1|B7.1-office|standard (default: B7.1)
#   JUDGE_EFFORT      effort level                  (default: unset)
#   PORT              server port                   (default: 3000)
#   DATA_DIR          base data directory           (default: /data)
#   AWS_REGION        AWS region for Bedrock        (default: eu-west-2)
#   HIJACK_THRESHOLD  strikes before autonomous lock (default: 2)
#   STORE_BACKEND     memory|dynamo                 (default: dynamo in sandbox)
#   DYNAMO_TABLE_NAME DynamoDB table for session state (default: jaid-sessions)
#   DYNAMO_REGION     Region of the Dynamo table    (default: eu-west-1)
#   DREDD_ROLE        hook|dashboard                (default: hook)
#   DREDD_HOOK_URL    URL the dashboard container reaches the hook container on
#                     (only used when DREDD_ROLE=dashboard)
#   DREDD_DASHBOARD_ORIGIN  Origin the hook container accepts CORS from
#                     (only used when DREDD_ROLE=hook)
#   DREDD_AUTH_MODE   off|optional|required         (default: optional)
#
# Hook role does NOT use Clerk env vars (CLERK_SECRET_KEY,
# CLERK_PUBLISHABLE_KEY) — those are only read by the dashboard
# container. Hooks authenticate via Bearer API keys.

MODE="${MODE:-interactive}"
BACKEND="${BACKEND:-bedrock}"
JUDGE_MODEL="${JUDGE_MODEL:-eu.anthropic.claude-sonnet-4-6}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-eu.cohere.embed-v4:0}"
HARDENED="${HARDENED:-B7.1}"
JUDGE_EFFORT="${JUDGE_EFFORT:-}"
PORT="${PORT:-3000}"
DATA_DIR="${DATA_DIR:-/data}"
HIJACK_THRESHOLD="${HIJACK_THRESHOLD:-2}"

export AWS_REGION="${AWS_REGION:-eu-west-2}"

# Session-state backend. Sandbox containers default to Dynamo so sessions
# survive task replacement and can be shared across containers behind an
# ALB (with sticky cookies keeping the hot path in-container).
export STORE_BACKEND="${STORE_BACKEND:-dynamo}"
export DYNAMO_TABLE_NAME="${DYNAMO_TABLE_NAME:-jaid-sessions}"
# The Dynamo table lives in eu-west-1; Bedrock is often eu-west-2. The
# DynamoSessionStore reads AWS_REGION, so pass the table's region via a
# dedicated env and swap just before invoking the SDK client.
export DYNAMO_REGION="${DYNAMO_REGION:-eu-west-1}"

# Role: the same image boots as either the hook hot-path server or the
# dashboard UI, picked at runtime by DREDD_ROLE. Default is "hook" so
# existing deployments (which didn't set DREDD_ROLE before the split)
# keep their previous behaviour. The dashboard task definition sets
# DREDD_ROLE=dashboard explicitly.
export DREDD_ROLE="${DREDD_ROLE:-hook}"
# Cross-container URLs. The dashboard needs to know the hook URL to
# call /api/feed + /api/mode from the browser. The hook needs to
# know the dashboard origin to return the right Access-Control-Allow-
# Origin. Both default to empty — same-origin single-process dev works
# without either.
export DREDD_HOOK_URL="${DREDD_HOOK_URL:-}"
export DREDD_DASHBOARD_ORIGIN="${DREDD_DASHBOARD_ORIGIN:-}"

# Auth mode for hook-facing endpoints. Default is "optional" (pass-through
# with telemetry) while we gather telemetry about who's still sending
# hooks without a key. Set to "required" to 401 missing keys.
export DREDD_AUTH_MODE="${DREDD_AUTH_MODE:-optional}"

SESSION_DIR="${DATA_DIR}/sessions"
LOG_DIR="${DATA_DIR}/logs"

mkdir -p "$SESSION_DIR" "$LOG_DIR"

echo "═══════════════════════════════════════════════════════"
echo "  Judge AI Dredd — Standalone Server"
echo "═══════════════════════════════════════════════════════"
echo "  Mode:           $MODE"
echo "  Backend:        $BACKEND"
echo "  Judge:          $JUDGE_MODEL"
echo "  Embedding:      $EMBEDDING_MODEL"
echo "  Prompt:         $HARDENED"
echo "  Hijack lock:    $HIJACK_THRESHOLD strike(s)"
echo "  Port:           $PORT"
echo "  Sessions:       $SESSION_DIR"
echo "  Logs:           $LOG_DIR"
echo "  Store backend:  $STORE_BACKEND"
if [ "$STORE_BACKEND" = "dynamo" ]; then
  echo "  Dynamo table:   $DYNAMO_TABLE_NAME (${DYNAMO_REGION})"
fi
echo "  Role:           $DREDD_ROLE"
if [ "$DREDD_ROLE" = "dashboard" ] && [ -n "$DREDD_HOOK_URL" ]; then
  echo "  Hook URL:       $DREDD_HOOK_URL"
fi
if [ "$DREDD_ROLE" = "hook" ] && [ -n "$DREDD_DASHBOARD_ORIGIN" ]; then
  echo "  Dashboard CORS: $DREDD_DASHBOARD_ORIGIN"
fi
echo "  Auth mode:      $DREDD_AUTH_MODE"
echo "═══════════════════════════════════════════════════════"

# Dump $DATA_DIR state at startup so we can tell whether the volume is
# persistent across restarts (expect non-zero counts on redeploy if EFS
# is mounted).
mount_line="$(awk -v d="$DATA_DIR" '$2==d {print $1" type "$3" ("$4")"}' /proc/mounts 2>/dev/null | head -1)"
session_count=$(find "$SESSION_DIR" -maxdepth 1 -type f -name 'session-*.json' 2>/dev/null | wc -l | tr -d ' ')
log_count=$(find "$LOG_DIR" -maxdepth 1 -type f -name '*.log' 2>/dev/null | wc -l | tr -d ' ')
data_bytes=$(du -sb "$DATA_DIR" 2>/dev/null | awk '{print $1}')
echo "  $DATA_DIR mount:   ${mount_line:-<not a mount point — ephemeral container layer>}"
echo "  $DATA_DIR bytes:   ${data_bytes:-unknown}"
echo "  Existing sessions: $session_count"
echo "  Existing logs:     $log_count"
if [ "$session_count" -gt 0 ]; then
  echo "  Newest 3 sessions:"
  ls -1t "$SESSION_DIR"/session-*.json 2>/dev/null | head -3 | sed 's/^/    /'
fi
echo "═══════════════════════════════════════════════════════"

ARGS=(
  --port "$PORT"
  --mode "$MODE"
  --backend "$BACKEND"
  --judge-model "$JUDGE_MODEL"
  --embedding-model "$EMBEDDING_MODEL"
  --prompt "$HARDENED"
  --hijack-threshold "$HIJACK_THRESHOLD"
  --log-dir "$SESSION_DIR"
  --console-log-dir "$LOG_DIR"
)

if [ -n "$JUDGE_EFFORT" ]; then
  ARGS+=(--judge-effort "$JUDGE_EFFORT")
fi

exec npx tsx src/server.ts "${ARGS[@]}"
