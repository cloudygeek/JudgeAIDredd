#!/usr/bin/env bash
set -euo pipefail

# Judge AI Dredd — Standalone Judge Server Entrypoint
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

MODE="${MODE:-interactive}"
BACKEND="${BACKEND:-bedrock}"
JUDGE_MODEL="${JUDGE_MODEL:-eu.anthropic.claude-sonnet-4-6}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-eu.cohere.embed-v4:0}"
HARDENED="${HARDENED:-B7.1}"
JUDGE_EFFORT="${JUDGE_EFFORT:-}"
PORT="${PORT:-3000}"
DATA_DIR="${DATA_DIR:-/data}"

export AWS_REGION="${AWS_REGION:-eu-west-2}"

SESSION_DIR="${DATA_DIR}/sessions"
LOG_DIR="${DATA_DIR}/logs"

mkdir -p "$SESSION_DIR" "$LOG_DIR"

echo "═══════════════════════════════════════════════════════"
echo "  Judge AI Dredd — Standalone Server"
echo "═══════════════════════════════════════════════════════"
echo "  Mode:       $MODE"
echo "  Backend:    $BACKEND"
echo "  Judge:      $JUDGE_MODEL"
echo "  Embedding:  $EMBEDDING_MODEL"
echo "  Prompt:     $HARDENED"
echo "  Port:       $PORT"
echo "  Sessions:   $SESSION_DIR"
echo "  Logs:       $LOG_DIR"
echo "═══════════════════════════════════════════════════════"

ARGS=(
  --port "$PORT"
  --mode "$MODE"
  --backend "$BACKEND"
  --judge-model "$JUDGE_MODEL"
  --embedding-model "$EMBEDDING_MODEL"
  --prompt "$HARDENED"
  --log-dir "$SESSION_DIR"
  --console-log-dir "$LOG_DIR"
)

if [ -n "$JUDGE_EFFORT" ]; then
  ARGS+=(--judge-effort "$JUDGE_EFFORT")
fi

exec npx tsx src/server.ts "${ARGS[@]}"
