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
# Helper: build a structured backfill envelope from the transcript JSONL.
#
# The server only consumes a tiny slice of the JSONL — user prompts,
# tool_use blocks, file IO from Read/Write/Edit, and the (lastUser,
# priorAssistant) anchor pair. Everything else (system prompts, tool
# results, attachments, file-history-snapshots, permission-mode markers)
# is ballast we don't need on the wire.
#
# Shipping the raw transcript hit a 1MB ceiling on macOS because the
# previous code passed the body through `curl -d "$(jq …)"`, and bash's
# argv truncation silently chopped the body — surfacing as HTTP 400
# "Invalid JSON body: Unexpected end of JSON input". This envelope drops
# the body to ~5KB on a 50-prompt session.
#
# The envelope shape mirrors `interface TranscriptSummary` in
# src/server-core.ts; bump `version` if you change non-additively.
# ---------------------------------------------------------------------------
build_transcript_summary() {
  local tp="$1"
  if [ -z "$tp" ] || [ ! -f "$tp" ]; then
    return 1
  fi
  jq -s '
    # Slurp every JSONL line into an array, then walk it once.
    # Synthetic command markers (<command-name>, <local-command-…>)
    # are filtered out — same predicate the server applies in
    # isSyntheticUserEntry().
    def text_of(content):
      if (content | type) == "string" then content
      elif (content | type) == "array" then
        ([content[] | select(.type == "text") | .text] | join("\n"))
      else "" end;

    # Full image blocks (with inline base64 data). Only the goal
    # turn ships full bytes via lastUserImages; non-goal turns ship
    # an image-count placeholder via images_count_only since the
    # server uses historical images for embedding/display only and
    # never re-encodes them for the judge.
    def images_of(content):
      if (content | type) == "array" then
        [content[]
          | select(.type == "image")
          | { source: (.source // null) }]
      else [] end;
    # Image-count placeholder. The server applyBackfill records
    # historical user prompts via tracker.registerIntent(images),
    # which uses images for embedding/display only and does not
    # re-encode the bytes for the judge. Empty source objects
    # preserve the per-turn image count without shipping the bytes.
    def images_count_only(content):
      if (content | type) == "array" then
        [content[] | select(.type == "image") | { source: null }]
      else [] end;

      def is_synthetic(msg; t):
        (msg.isMeta == true)
        or (t | startswith("<command-name>"))
        or (t | startswith("<local-command-"))
        or (t | startswith("<command-message>"))
        or (t | startswith("<command-args>"));

      def is_confirmation(s):
        (s
          | ascii_downcase
          | gsub("[.!?\\s]"; ""))
        | (length < 80 and (
              . == "yes" or . == "yeah" or . == "yep" or . == "ok"
              or . == "okay" or . == "sure" or . == "doit"
              or . == "goahead" or . == "go" or . == "proceed"
              or . == "continue" or . == "y" or . == "k"
              or . == "confirm" or . == "approve" or . == "approved"
              or . == "lgtm" or . == "shipit" or . == "soundsgood"
              or . == "thatsright" or . == "correct" or . == "exactly"
              or . == "please" or . == "thanks" or . == "thankyou"));

    # User prompts (oldest first), with images.
    [ .[] | select(.type == "user") |
        . as $msg |
        text_of(.message.content) as $raw |
        ($raw | gsub("^\\s+|\\s+$"; "")) as $t |
        images_count_only(.message.content) as $imgs |
        select(is_synthetic($msg; $t) | not) |
        select(($t | length) > 0 or ($imgs | length) > 0) |
        { text: $t, images: $imgs }
    ] as $userPrompts |

    # Tool calls + file IO from assistant tool_use blocks.
    # Cap stringy fields in tool_input so a 50KB Edit payload x 50
    # tool_use blocks does not reflate the envelope. Shape preserved;
    # only string values get clipped. The server recordToolCall path
    # also truncates server-side, but trimming here saves bandwidth.
    def cap_strings(o; n):
      if (o | type) == "object" then
        o
        | with_entries(.value = (
            if (.value | type) == "string" and (.value | length) > n
              then .value[0:n] else .value end))
      else o end;

    # Backfill only consults tool history when a session is cold —
    # never seen before by the server. The most recent N calls are
    # enough to seed the recent-tool view; older ones are noise.
    # Cap at 50 to bound the envelope on long sessions.
    ([ .[] | select(.type == "assistant") |
        (.message.content // []) | select(type == "array") | .[] |
        select(.type == "tool_use") |
        { tool: .name, input: cap_strings(.input // {}; 4000) }
    ] | (if length > 50 then .[(length - 50):] else . end)
    ) as $toolCalls |

    [ $toolCalls[] | select(.tool == "Read") | (.input.file_path // "") ] as $filesRead |
    [ $toolCalls[] |
        select(.tool == "Write" or .tool == "Edit") |
        { path: (.input.file_path // ""),
          # Server caps file content at 10KB; ship 4KB to match the
          # tool-input cap and keep the envelope small.
          content: (if .tool == "Write"
                    then ((.input.content // "")[0:4000])
                    else ((.input.new_string // "")[0:4000]) end),
          isEdit: (.tool == "Edit") }
    ] as $filesWritten |

    # lastUser / priorAssistant: walk in order, remember the most
    # recent assistant text, and pick the most recent NON-confirmation
    # user prompt as the goal anchor. `reduce` cannot be bound via
    # `as` directly — wrap the whole expression in parens.
    (reduce (.[] | select(.type == "user" or .type == "assistant")) as $m
      ({ pendingAssistant: null, turns: [] };
        if $m.type == "assistant" then
          (text_of($m.message.content) | gsub("^\\s+|\\s+$"; "")) as $t |
          (if ($t | length) > 0 then .pendingAssistant = $t else . end)
        else
          (text_of($m.message.content) | gsub("^\\s+|\\s+$"; "")) as $t |
          # Full image data here; only the goal turn gets picked
          # out below for lastUserImages, so non-goal-turn entries
          # have their full-data lists dropped on the floor by the
          # consumer. We still emit them here so the goal-finder
          # logic does not have to do a second pass.
          images_of($m.message.content) as $imgs |
          (if (is_synthetic($m; $t) | not) and (($t | length) > 0 or ($imgs | length) > 0)
           then .turns += [{ user: $t, prior: .pendingAssistant, images: $imgs }]
           else . end)
        end)) as $st |
    ($st.turns
      | (if length == 0 then null
         else
           # Walk from newest to oldest, take the first non-confirmation.
           ([.[] | select(is_confirmation(.user) | not)] |
              if length > 0 then .[-1] else (.[length - 1]) end)
         end)) as $goal |

    {
      version: 1,
      userPrompts: $userPrompts,
      lastUserText: ($goal.user // null),
      lastUserImages: ($goal.images // []),
      priorAssistantText: ($goal.prior // null),
      toolCalls: $toolCalls,
      filesRead: $filesRead,
      filesWritten: $filesWritten
    }
  ' "$tp" 2>/dev/null
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
    DREDD_DEBUG_LOG="${DREDD_DEBUG_LOG:-$HOME/.claude/dredd/hook-debug.log}"

    # Build a structured backfill envelope. The server prefers this
    # over the raw JSONL transcript — ships ~5KB on a 50-prompt
    # session vs ~800KB raw, and avoids the macOS ARG_MAX truncation
    # that bit /intent on 2026-05-12 (transcripts >1MB encoded as
    # `curl -d "$(...)"` got chopped, surfacing as HTTP 400
    # "Invalid JSON body: Unexpected end of JSON input").
    SUMMARY_FILE=$(mktemp -t dredd-summary.XXXXXX)
    if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
      build_transcript_summary "$TRANSCRIPT_PATH" >"$SUMMARY_FILE" 2>/dev/null
    fi
    # If the summary build produced nothing usable, drop it — the
    # server has a transcript_path fallback that re-reads from disk
    # (only works on local installs, not remote/Fargate, but better
    # than nothing).
    if [ ! -s "$SUMMARY_FILE" ]; then
      rm -f "$SUMMARY_FILE" 2>/dev/null || true
      SUMMARY_FILE=""
    fi
    SUMMARY_SIZE=0
    if [ -n "$SUMMARY_FILE" ]; then
      SUMMARY_SIZE=$(wc -c < "$SUMMARY_FILE" 2>/dev/null | tr -d ' ')
    fi

    CLAUDEMD_CONTENT=$(read_claudemd_content "$CWD")

    # Compose the request body. jq reads the summary from a slurped
    # file, side-stepping argv. The full transcript is no longer sent
    # — if the server can't make sense of the summary it falls back
    # to transcript_path, which it already has via the hook input.
    REQ_BODY_FILE=$(mktemp -t dredd-intent-req.XXXXXX)
    if [ -n "$SUMMARY_FILE" ]; then
      jq -n \
        --arg sid "$SESSION_ID" \
        --arg prompt "$PROMPT" \
        --arg cwd "$CWD" \
        --arg tp "$TRANSCRIPT_PATH" \
        --arg cm "$CLAUDEMD_CONTENT" \
        --arg mode "$DREDD_MODE" \
        --slurpfile sum "$SUMMARY_FILE" \
        '{
          session_id: $sid,
          prompt: $prompt,
          cwd: $cwd,
          transcript_path: (if $tp == "" then null else $tp end),
          transcript_summary: ($sum | first),
          claudemd_content: (if $cm == "" then null else $cm end),
          mode: (if $mode == "" then null else $mode end)
        }' >"$REQ_BODY_FILE"
    else
      jq -n \
        --arg sid "$SESSION_ID" \
        --arg prompt "$PROMPT" \
        --arg cwd "$CWD" \
        --arg tp "$TRANSCRIPT_PATH" \
        --arg cm "$CLAUDEMD_CONTENT" \
        --arg mode "$DREDD_MODE" \
        '{
          session_id: $sid,
          prompt: $prompt,
          cwd: $cwd,
          transcript_path: (if $tp == "" then null else $tp end),
          claudemd_content: (if $cm == "" then null else $cm end),
          mode: (if $mode == "" then null else $mode end)
        }' >"$REQ_BODY_FILE"
    fi

    # POST with --data-binary @file so the body never rides on argv.
    # macOS ARG_MAX is 1MB; the previous `-d "$(jq …)"` form
    # silently truncated the body past that boundary and the server
    # returned HTTP 400 with no recoverable trace.
    INTENT_BODY_FILE=$(mktemp -t dredd-intent.XXXXXX)
    HTTP_CODE=$(curl -s -X POST "$DREDD_URL/intent" \
      "${DREDD_CURL_ARGS[@]}" \
      -H "Content-Type: application/json" \
      -o "$INTENT_BODY_FILE" \
      -w '%{http_code}' \
      --data-binary "@$REQ_BODY_FILE" \
      --connect-timeout 5 --max-time 30 2>/dev/null)
    HTTP_CODE="${HTTP_CODE:-000}"
    if [ "$HTTP_CODE" != "200" ]; then
      BODY_PREVIEW=$(head -c 200 "$INTENT_BODY_FILE" 2>/dev/null || echo "")
      REQ_SIZE=$(wc -c < "$REQ_BODY_FILE" 2>/dev/null | tr -d ' ')
      printf '[%s] %s — /intent HTTP %s (session=%s, body_bytes=%s, summary_bytes=%s): %s\n' \
        "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "UserPromptSubmit" "$HTTP_CODE" "${SESSION_ID:0:8}" \
        "$REQ_SIZE" "$SUMMARY_SIZE" "$BODY_PREVIEW" \
        >>"$DREDD_DEBUG_LOG" 2>/dev/null || true
      # Emit empty hook output so the prompt still goes through.
      # Server-side state is recoverable via /evaluate's rehydration.
      echo '{}'
    else
      # Extract just the hook fields (systemMessage etc), strip _meta.
      jq 'del(._meta)' "$INTENT_BODY_FILE" 2>/dev/null || echo '{}'
    fi
    rm -f "$INTENT_BODY_FILE" "$REQ_BODY_FILE" "$SUMMARY_FILE" 2>/dev/null || true
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

    # Backfill envelope, only consulted server-side if the session
    # isn't already in Dredd's in-memory cache or Dynamo. The summary
    # is small (~5KB on a 50-prompt session) so it's safe to attach
    # on every /evaluate; UserPromptSubmit usually has it covered, but
    # a cold-start /evaluate (container failover, fresh deploy) needs
    # *some* backfill source.
    EVAL_SUMMARY_FILE=$(mktemp -t dredd-eval-summary.XXXXXX)
    if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
      build_transcript_summary "$TRANSCRIPT_PATH" >"$EVAL_SUMMARY_FILE" 2>/dev/null
    fi
    if [ ! -s "$EVAL_SUMMARY_FILE" ]; then
      rm -f "$EVAL_SUMMARY_FILE" 2>/dev/null || true
      EVAL_SUMMARY_FILE=""
    fi

    EVAL_REQ_FILE=$(mktemp -t dredd-eval-req.XXXXXX)
    if [ -n "$EVAL_SUMMARY_FILE" ]; then
      jq -n \
        --arg sid "$SESSION_ID" \
        --arg tn "$TOOL_NAME" \
        --argjson ti "$TOOL_INPUT" \
        --arg ar "$AGENT_REASONING" \
        --arg tp "$TRANSCRIPT_PATH" \
        --arg mode "$DREDD_MODE" \
        --slurpfile sum "$EVAL_SUMMARY_FILE" \
        '{
          session_id: $sid,
          tool_name: $tn,
          tool_input: $ti,
          agent_reasoning: $ar,
          transcript_path: (if $tp == "" then null else $tp end),
          transcript_summary: ($sum | first),
          mode: (if $mode == "" then null else $mode end)
        }' >"$EVAL_REQ_FILE"
    else
      jq -n \
        --arg sid "$SESSION_ID" \
        --arg tn "$TOOL_NAME" \
        --argjson ti "$TOOL_INPUT" \
        --arg ar "$AGENT_REASONING" \
        --arg tp "$TRANSCRIPT_PATH" \
        --arg mode "$DREDD_MODE" \
        '{
          session_id: $sid,
          tool_name: $tn,
          tool_input: $ti,
          agent_reasoning: $ar,
          transcript_path: (if $tp == "" then null else $tp end),
          mode: (if $mode == "" then null else $mode end)
        }' >"$EVAL_REQ_FILE"
    fi

    RESPONSE=$(curl -s -X POST "$DREDD_URL/evaluate" \
      "${DREDD_CURL_ARGS[@]}" \
      -H "Content-Type: application/json" \
      --data-binary "@$EVAL_REQ_FILE" \
      --connect-timeout 5 --max-time 60)

    rm -f "$EVAL_REQ_FILE" "$EVAL_SUMMARY_FILE" 2>/dev/null || true
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
    # Stop fires after every assistant turn (not at session end). We POST
    # to /stop so the server can mark the turn boundary — this is what
    # lets the interactive intent stack distinguish DRAINING (queued
    # prompt) from CLOSED (next-turn prompt). Fire-and-forget; we do
    # NOT call /end here (that would wipe the session state and cause
    # the next user prompt to be registered as a new "original intent",
    # breaking confirmation handling).
    curl -s -X POST "$DREDD_URL/stop" \
      "${DREDD_CURL_ARGS[@]}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg sid "$SESSION_ID" '{session_id: $sid}')" \
      --connect-timeout 2 --max-time 5 > /dev/null 2>&1 &
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
