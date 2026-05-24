#!/bin/bash
# run-clean.sh — invoke drive.mjs from a scrubbed environment.
#
# Why: when claude -p is spawned by another claude (or by an SDK driver
# launched from one), the child can inherit auth tokens and CLAUDE_CODE_*
# vars that confuse credential resolution. We use `env -i` to give the child
# only the bare minimum.
#
# Required positional args: VARIANT (baseline|dredd) and RUN_INDEX (any string).
# Reads DREDD_API_KEY from the environment when VARIANT=dredd.
set -eu

VARIANT="${1:?usage: $0 <baseline|dredd> <run_index>}"
RUN_INDEX="${2:?usage: $0 <baseline|dredd> <run_index>}"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-/tmp/dredd-ab/repo}"
TASK_FILE="${TASK_FILE:-task.json}"
TASK_TAG="$(echo "$TASK_FILE" | sed -e 's/\.json$//' -e 's/^task//' -e 's/^-//')"
OUT_DIR="${OUT_DIR:-$HERE/results${TASK_TAG:+-$TASK_TAG}}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/${VARIANT}-${RUN_INDEX}-${STAMP}.jsonl"
DREDD_URL="${DREDD_URL:-https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal}"

mkdir -p "$OUT_DIR"

# Reset the test repo's worktree so each run starts identically.
( cd "$REPO" && git restore . && git clean -fd >/dev/null )

# Resolve absolute paths inside the calling shell, before env -i wipes
# everything we need to look up.
NODE_BIN="$(command -v node)"
CLAUDE_BIN="$(command -v claude)"
NODE_DIR="$(dirname "$NODE_BIN")"
CLAUDE_DIR="$(dirname "$CLAUDE_BIN")"

CLEAN_PATH="$CLAUDE_DIR:$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

DREDD_KEY=""
if [ "$VARIANT" = "dredd" ]; then
  DREDD_KEY="${DREDD_API_KEY:?DREDD_API_KEY required for dredd variant}"
fi

echo "[run-clean] variant=$VARIANT run=$RUN_INDEX out=$OUT"

# Re-exec drive.mjs with a near-empty env. AWS creds resolve from
# ~/.aws/credentials via $HOME so we keep HOME. AWS_PROFILE is optional —
# preserve if set in the caller's env.
env -i \
  HOME="$HOME" \
  PATH="$CLEAN_PATH" \
  AWS_REGION="${AWS_REGION:-eu-west-2}" \
  ${AWS_PROFILE:+AWS_PROFILE="$AWS_PROFILE"} \
  CLAUDE_CODE_USE_BEDROCK=1 \
  ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-eu.anthropic.claude-sonnet-4-6}" \
  ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-eu.anthropic.claude-haiku-4-5}" \
  VARIANT="$VARIANT" \
  REPO="$REPO" \
  OUT="$OUT" \
  RUN_INDEX="$RUN_INDEX" \
  DREDD_URL="$DREDD_URL" \
  DREDD_API_KEY="$DREDD_KEY" \
  DREDD_MODE=interactive \
  TASK_FILE="$TASK_FILE" \
  STEP_TIMEOUT_MS="${STEP_TIMEOUT_MS:-120000}" \
  HARD_TIMEOUT_MS="${HARD_TIMEOUT_MS:-1200000}" \
  "$NODE_BIN" "$HERE/drive.mjs"
