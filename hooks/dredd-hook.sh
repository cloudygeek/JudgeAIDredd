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
#       }]
#     }
#   }
# =============================================================================

DREDD_URL="${DREDD_URL:-http://localhost:3001}"

# Read hook input from stdin
INPUT=$(cat)

# Extract common fields
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# If server is down, fall back to user prompt
if ! curl -s --connect-timeout 1 "$DREDD_URL/health" > /dev/null 2>&1; then
  if [ "$HOOK_EVENT" = "PreToolUse" ]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Judge Dredd server unavailable — requesting user approval"}}'
  else
    echo '{}'
  fi
  exit 0
fi

case "$HOOK_EVENT" in
  "UserPromptSubmit")
    PROMPT=$(echo "$INPUT" | jq -r '.prompt // .message // empty')
    RESPONSE=$(curl -s -X POST "$DREDD_URL/intent" \
      -H "Content-Type: application/json" \
      -d "{\"session_id\": \"$SESSION_ID\", \"prompt\": $(echo "$PROMPT" | jq -Rs .)}" \
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
      # Get the last assistant message (text content blocks)
      AGENT_REASONING=$(tail -20 "$TRANSCRIPT_PATH" \
        | grep -o '"type":"assistant".*' \
        | tail -1 \
        | jq -r '.message.content[]? | select(.type=="text") | .text' 2>/dev/null \
        | head -c 500)
    fi

    RESPONSE=$(curl -s -X POST "$DREDD_URL/evaluate" \
      -H "Content-Type: application/json" \
      -d "{\"session_id\": \"$SESSION_ID\", \"tool_name\": \"$TOOL_NAME\", \"tool_input\": $TOOL_INPUT, \"agent_reasoning\": $(echo "$AGENT_REASONING" | jq -Rs .)}" \
      --connect-timeout 5 --max-time 60)

    echo "$RESPONSE" | jq 'del(._meta)' 2>/dev/null || echo '{}'
    ;;

  "PostToolUse")
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
    TOOL_INPUT=$(echo "$INPUT" | jq '.tool_input // {}')
    TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // empty' | head -c 5000)

    # Async — fire and forget, don't block the agent
    curl -s -X POST "$DREDD_URL/track" \
      -H "Content-Type: application/json" \
      -d "{\"session_id\": \"$SESSION_ID\", \"tool_name\": \"$TOOL_NAME\", \"tool_input\": $TOOL_INPUT, \"tool_output\": $(echo "$TOOL_OUTPUT" | jq -Rs .)}" \
      --connect-timeout 2 --max-time 5 > /dev/null 2>&1 &

    echo '{}'
    ;;

  "Stop")
    curl -s -X POST "$DREDD_URL/end" \
      -H "Content-Type: application/json" \
      -d "{\"session_id\": \"$SESSION_ID\"}" \
      --connect-timeout 2 --max-time 10 > /dev/null 2>&1 &

    echo '{}'
    ;;

  "PreCompact")
    # Context is being compacted — notify Dredd so it can record the boundary
    curl -s -X POST "$DREDD_URL/compact" \
      -H "Content-Type: application/json" \
      -d "{\"session_id\": \"$SESSION_ID\"}" \
      --connect-timeout 2 --max-time 5 > /dev/null 2>&1 &

    echo '{}'
    ;;

  *)
    echo '{}'
    ;;
esac
