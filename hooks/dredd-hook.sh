#!/bin/bash
# =============================================================================
# Judge Dredd — Claude Code CLI Hook
#
# Single hook script that handles all hook events by routing to the
# Judge Dredd HTTP server. Drop this into your project's .claude/settings.json.
#
# The hook reads the event from stdin (JSON), calls the appropriate
# Dredd endpoint, and prints the response to stdout (JSON) for
# Claude Code to consume.
#
# Remote-compatible: sends file CONTENTS (transcript, CLAUDE.md) inline
# so the server does not need filesystem access to the client machine.
#
# Prerequisites:
#   - Judge Dredd server running: npx tsx src/server.ts
#   - curl and jq installed
#
# Installation — add to .claude/settings.json:
#
#   {
#     "hooks": {
#       "UserPromptSubmit": [{
#         "type": "command",
#         "command": "/path/to/JudgeAIDredd/hooks/dredd-hook.sh"
#       }],
#       "PreToolUse": [{
#         "type": "command",
#         "command": "/path/to/JudgeAIDredd/hooks/dredd-hook.sh"
#       }],
#       "PostToolUse": [{
#         "type": "command",
#         "command": "/path/to/JudgeAIDredd/hooks/dredd-hook.sh"
#       }],
#       "Stop": [{
#         "type": "command",
#         "command": "/path/to/JudgeAIDredd/hooks/dredd-hook.sh"
#       }],
#       "SessionEnd": [{
#         "type": "command",
#         "command": "/path/to/JudgeAIDredd/hooks/dredd-hook.sh"
#       }]
#     }
#   }
# =============================================================================

DREDD_URL="${DREDD_URL:-http://localhost:3001}"
# Optional per-client trust mode override. Unset = use the server's default.
# Accepts: interactive | autonomous | learn
DREDD_MODE="${DREDD_MODE:-}"

# Per-session ALB cookie jar. The Dredd backend is stateful: each container
# holds an in-memory cache of the session's state. Pinning a session to a
# container via the AWSALB cookie turns every request after the first into
# a cache hit and saves a DynamoDB round-trip. If the sticky target dies,
# ALB reroutes and the new container reconstructs state from DynamoDB —
# transparent to the hook.
DREDD_COOKIE_DIR="${DREDD_COOKIE_DIR:-$HOME/.claude/dredd/cookies}"
mkdir -p "$DREDD_COOKIE_DIR" 2>/dev/null || true

# Read hook input from stdin
INPUT=$(cat)

# Extract common fields
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Cookie jar path — only safe to set when we have a SESSION_ID so concurrent
# sessions don't clobber each other. No jar for an empty session id.
COOKIE_JAR=""
if [ -n "$SESSION_ID" ]; then
  # Sanitise just in case — session ids are already uuid-ish.
  safe_sid=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')
  COOKIE_JAR="$DREDD_COOKIE_DIR/$safe_sid.jar"
fi

# ---------------------------------------------------------------------------
# API key (optional during the rollout grace period).
#
# Looks for a key at $HOME/.claude/dredd/api-key (or $DREDD_API_KEY_FILE) —
# one key per file, no trailing newline significance. If the file doesn't
# exist, requests go out without an Authorization header and the server's
# DREDD_AUTH_MODE decides whether that's allowed.
#
# Perms are NOT enforced by this script but the dashboard's "Generate key"
# flow instructs the user to chmod 600 and set strict parent dir perms.
# ---------------------------------------------------------------------------
DREDD_API_KEY_FILE="${DREDD_API_KEY_FILE:-$HOME/.claude/dredd/api-key}"
DREDD_API_KEY=""
if [ -r "$DREDD_API_KEY_FILE" ]; then
  # tr strips whitespace / newlines that creep in via copy-paste or editors.
  DREDD_API_KEY=$(tr -d '[:space:]' < "$DREDD_API_KEY_FILE")
fi

# Curl flags array for each request. Using an array (not a function that
# prints flags) because the Authorization value contains a space ("Bearer
# <key>") and printf+word-splitting mangles it — an array expansion with
# "${DREDD_CURL_ARGS[@]}" preserves the value as a single argv entry.
DREDD_CURL_ARGS=()
if [ -n "$COOKIE_JAR" ]; then
  DREDD_CURL_ARGS+=(--cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR")
fi
if [ -n "$DREDD_API_KEY" ]; then
  DREDD_CURL_ARGS+=(-H "Authorization: Bearer $DREDD_API_KEY")
fi

# If server is down, fall back to user prompt
if ! curl -s --connect-timeout 1 "$DREDD_URL/health" > /dev/null 2>&1; then
  if [ "$HOOK_EVENT" = "PreToolUse" ]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Judge AI Dredd server unavailable — requesting user approval"}}'
  else
    echo '{}'
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Helper: read transcript content.
#
# UserPromptSubmit sends the full transcript so server-side backfill can
# replay every user turn (see $TRANSCRIPT_TAIL_LIMIT below). PreToolUse
# uses a bounded tail to keep high-frequency tool events cheap — backfill
# from PreToolUse only fires if Dredd hasn't seen this session yet, which
# is rare once UserPromptSubmit has already run for the session.
# ---------------------------------------------------------------------------
read_transcript_content() {
  local tp="$1"
  local limit="${2:-0}"   # 0 = whole file
  if [ -n "$tp" ] && [ -f "$tp" ]; then
    if [ "$limit" -gt 0 ]; then
      tail -"$limit" "$tp"
    else
      cat "$tp"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Helper: read CLAUDE.md files from the project cwd
# ---------------------------------------------------------------------------
read_claudemd_content() {
  local cwd="$1"
  local content=""
  if [ -n "$cwd" ]; then
    if [ -f "$cwd/CLAUDE.md" ]; then
      content=$(cat "$cwd/CLAUDE.md")
    fi
    if [ -f "$cwd/.claude/CLAUDE.md" ]; then
      if [ -n "$content" ]; then
        content="$content"$'\n\n--- .claude/CLAUDE.md ---\n\n'
      fi
      content="$content$(cat "$cwd/.claude/CLAUDE.md")"
    fi
  fi
  echo "$content"
}

case "$HOOK_EVENT" in
  "UserPromptSubmit")
    PROMPT=$(echo "$INPUT" | jq -r '.prompt // .message // empty')
    TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
    CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

    # Full transcript — the server replays every user turn into the tracker
    # so resumed sessions (`claude --continue`) retain their complete intent
    # history, not just first + last prompt.
    TRANSCRIPT_CONTENT=$(read_transcript_content "$TRANSCRIPT_PATH" 0)
    CLAUDEMD_CONTENT=$(read_claudemd_content "$CWD")

    RESPONSE=$(curl -s -X POST "$DREDD_URL/intent" \
      "${DREDD_CURL_ARGS[@]}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --arg sid "$SESSION_ID" \
        --arg prompt "$PROMPT" \
        --arg cwd "$CWD" \
        --arg tc "$TRANSCRIPT_CONTENT" \
        --arg cm "$CLAUDEMD_CONTENT" \
        --arg mode "$DREDD_MODE" \
        '{
          session_id: $sid,
          prompt: $prompt,
          cwd: $cwd,
          transcript_content: (if $tc == "" then null else $tc end),
          claudemd_content: (if $cm == "" then null else $cm end),
          mode: (if $mode == "" then null else $mode end)
        }')" \
      --connect-timeout 5 --max-time 30)

    # Extract just the hook fields (systemMessage etc), strip _meta
    echo "$RESPONSE" | jq 'del(._meta)' 2>/dev/null || echo '{}'
    ;;

  "PreToolUse")
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
    TOOL_INPUT=$(echo "$INPUT" | jq '.tool_input // {}')
    TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

    # Extract the last assistant message from the transcript for context
    AGENT_REASONING=""
    if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
      AGENT_REASONING=$(tail -20 "$TRANSCRIPT_PATH" \
        | grep -o '"type":"assistant".*' \
        | tail -1 \
        | jq -r '.message.content[]? | select(.type=="text") | .text' 2>/dev/null \
        | head -c 500)
    fi

    # Read transcript content for backfill (only needed if server hasn't
    # seen this session). Bounded tail keeps hot-path tool-call overhead low;
    # UserPromptSubmit already sends the full transcript, so by the time
    # evaluate fires Dredd normally has the full history anyway.
    TRANSCRIPT_CONTENT=$(read_transcript_content "$TRANSCRIPT_PATH" 500)

    RESPONSE=$(curl -s -X POST "$DREDD_URL/evaluate" \
      "${DREDD_CURL_ARGS[@]}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --arg sid "$SESSION_ID" \
        --arg tn "$TOOL_NAME" \
        --argjson ti "$TOOL_INPUT" \
        --arg ar "$AGENT_REASONING" \
        --arg tc "$TRANSCRIPT_CONTENT" \
        --arg mode "$DREDD_MODE" \
        '{
          session_id: $sid,
          tool_name: $tn,
          tool_input: $ti,
          agent_reasoning: $ar,
          transcript_content: (if $tc == "" then null else $tc end),
          mode: (if $mode == "" then null else $mode end)
        }')" \
      --connect-timeout 5 --max-time 60)

    echo "$RESPONSE" | jq 'del(._meta)' 2>/dev/null || echo '{}'
    ;;

  "PostToolUse")
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
    TOOL_INPUT=$(echo "$INPUT" | jq '.tool_input // {}')
    TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // empty' | head -c 5000)

    # Async — fire and forget, don't block the agent
    curl -s -X POST "$DREDD_URL/track" \
      "${DREDD_CURL_ARGS[@]}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --arg sid "$SESSION_ID" \
        --arg tn "$TOOL_NAME" \
        --argjson ti "$TOOL_INPUT" \
        --arg to "$TOOL_OUTPUT" \
        '{
          session_id: $sid,
          tool_name: $tn,
          tool_input: $ti,
          tool_output: $to
        }')" \
      --connect-timeout 2 --max-time 5 > /dev/null 2>&1 &

    echo '{}'
    ;;

  "Stop")
    # Stop fires after every assistant turn (not at session end). Do NOT
    # call /end here — that would wipe the session state and cause the next
    # user prompt to be registered as a new "original intent", breaking
    # interactive-mode confirmation handling.
    echo '{}'
    ;;

  "SessionEnd")
    curl -s -X POST "$DREDD_URL/end" \
      "${DREDD_CURL_ARGS[@]}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg sid "$SESSION_ID" '{session_id: $sid}')" \
      --connect-timeout 2 --max-time 10 > /dev/null 2>&1 &

    # Clean up the sticky cookie jar — the session is over.
    if [ -n "$COOKIE_JAR" ] && [ -f "$COOKIE_JAR" ]; then
      rm -f "$COOKIE_JAR" 2>/dev/null || true
    fi

    echo '{}'
    ;;

  "PreCompact")
    # Context is being compacted — notify Dredd so it can record the boundary
    curl -s -X POST "$DREDD_URL/compact" \
      "${DREDD_CURL_ARGS[@]}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg sid "$SESSION_ID" '{session_id: $sid}')" \
      --connect-timeout 2 --max-time 5 > /dev/null 2>&1 &

    echo '{}'
    ;;

  "Notification")
    # Claude Code surfaced a notification/permission prompt to the user.
    # Record it so the dashboard and A/B harness can count user-visible
    # friction. Fire-and-forget — the prompt has already been shown by
    # the time we get here, so blocking the hook serves no purpose.
    MESSAGE=$(echo "$INPUT" | jq -r '.message // empty')
    curl -s -X POST "$DREDD_URL/notification" \
      "${DREDD_CURL_ARGS[@]}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg sid "$SESSION_ID" --arg msg "$MESSAGE" \
            '{session_id: $sid, message: $msg}')" \
      --connect-timeout 2 --max-time 5 > /dev/null 2>&1 &

    echo '{}'
    ;;

  *)
    echo '{}'
    ;;
esac
