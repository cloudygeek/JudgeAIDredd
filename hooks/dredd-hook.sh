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

# ---------------------------------------------------------------------------
# Helper: read transcript content (last 200 lines to keep payload bounded)
# ---------------------------------------------------------------------------
read_transcript_content() {
  local tp="$1"
  if [ -n "$tp" ] && [ -f "$tp" ]; then
    tail -200 "$tp"
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

    # Read file contents locally and send inline
    TRANSCRIPT_CONTENT=$(read_transcript_content "$TRANSCRIPT_PATH")
    CLAUDEMD_CONTENT=$(read_claudemd_content "$CWD")

    RESPONSE=$(curl -s -X POST "$DREDD_URL/intent" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --arg sid "$SESSION_ID" \
        --arg prompt "$PROMPT" \
        --arg cwd "$CWD" \
        --arg tc "$TRANSCRIPT_CONTENT" \
        --arg cm "$CLAUDEMD_CONTENT" \
        '{
          session_id: $sid,
          prompt: $prompt,
          cwd: $cwd,
          transcript_content: (if $tc == "" then null else $tc end),
          claudemd_content: (if $cm == "" then null else $cm end)
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

    # Read transcript content for backfill (only needed if server hasn't seen this session)
    TRANSCRIPT_CONTENT=$(read_transcript_content "$TRANSCRIPT_PATH")

    RESPONSE=$(curl -s -X POST "$DREDD_URL/evaluate" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --arg sid "$SESSION_ID" \
        --arg tn "$TOOL_NAME" \
        --argjson ti "$TOOL_INPUT" \
        --arg ar "$AGENT_REASONING" \
        --arg tc "$TRANSCRIPT_CONTENT" \
        '{
          session_id: $sid,
          tool_name: $tn,
          tool_input: $ti,
          agent_reasoning: $ar,
          transcript_content: (if $tc == "" then null else $tc end)
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
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg sid "$SESSION_ID" '{session_id: $sid}')" \
      --connect-timeout 2 --max-time 10 > /dev/null 2>&1 &

    echo '{}'
    ;;

  "PreCompact")
    # Context is being compacted — notify Dredd so it can record the boundary
    curl -s -X POST "$DREDD_URL/compact" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg sid "$SESSION_ID" '{session_id: $sid}')" \
      --connect-timeout 2 --max-time 5 > /dev/null 2>&1 &

    echo '{}'
    ;;

  *)
    echo '{}'
    ;;
esac
