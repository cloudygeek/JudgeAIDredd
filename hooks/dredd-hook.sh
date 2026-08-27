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
#
# This script also handles PostToolUseFailure, PermissionDenied,
# InstructionsLoaded, PreCompact, and Notification — see hooks/settings.json.example for the
# full, copy-pasteable hook block wiring every event.
# =============================================================================

DREDD_URL="${DREDD_URL:-http://localhost:3001}"
# Optional per-client trust mode override. Unset = use the server's default.
# Accepts: interactive | autonomous | learn
DREDD_MODE="${DREDD_MODE:-}"

# Managed-allow scope (Phase 7b). Controls which patterns Dredd splices
# into the project's .claude/settings.local.json so Claude Code stops
# prompting for tool calls Dredd is already authorising.
#   "conservative" (default) — read-only / inspection patterns Dredd's
#       own policy already allow-lists (Read, Grep, awk/sed/ls/cat …).
#   "off"                    — Dredd never writes managed rules.
#
# DREDD_MANAGED_ALLOW_RULES lets an operator override with a custom
# JSON array (e.g. via systemd EnvironmentFile or shell rc), bypassing
# scope-driven defaults.
DREDD_MANAGED_ALLOW_SCOPE="${DREDD_MANAGED_ALLOW_SCOPE:-conservative}"
DREDD_MANAGED_ALLOW_RULES="${DREDD_MANAGED_ALLOW_RULES:-}"

# Phase 7a primitives live in the sibling dredd-managed-allow.sh. In a
# repo/dev checkout we source it. The integration-bundle / hook-script
# baker REPLACES this whole BEGIN/END block with the lib inlined, so a
# client install is a single self-contained file (the lib is not shipped
# separately). Guarded with [ -f ] so a missing lib degrades gracefully —
# the managed-allow call sites below are each `command -v`-guarded too, so
# the hook still runs, it just skips managed-allow.
# shellcheck disable=SC1091
# >>> DREDD_MANAGED_ALLOW_LIB (BEGIN) <<<
_dredd_lib="$(dirname "${BASH_SOURCE[0]:-$0}")/dredd-managed-allow.sh"
[ -f "$_dredd_lib" ] && . "$_dredd_lib"
# >>> DREDD_MANAGED_ALLOW_LIB (END) <<<

# Return the JSON array of rules for a given scope name. Conservative
# is the only non-trivial scope in v1; "off" returns an empty array
# (reconcile then strips any previously-managed rules).
_dredd_rules_for_scope() {
  local scope="$1"
  if [ -n "$DREDD_MANAGED_ALLOW_RULES" ]; then
    # Operator override wins — trust the JSON they gave us. Validate
    # by round-tripping through jq; on parse failure fall back to
    # scope defaults to avoid sending garbage to the matcher.
    if printf '%s' "$DREDD_MANAGED_ALLOW_RULES" | jq -e 'type == "array"' >/dev/null 2>&1; then
      printf '%s' "$DREDD_MANAGED_ALLOW_RULES" | jq -c .
      return 0
    fi
  fi
  case "$scope" in
    off)
      printf '[]'
      ;;
    conservative|*)
      # Read-only / inspection tools that Dredd's own ALLOWED_BASH_PATTERNS
      # already approves. Adding these to settings.local.json lets Claude
      # Code skip its native prompt — Dredd still sees the call and can
      # still deny via the user-deny list (Phase 4) or dangerous-combo
      # detection. Conservative on purpose: NO rm/curl/wget/sudo/git-push.
      cat <<'EOF'
[
  "Read",
  "Glob",
  "Grep",
  "Bash(awk:*)",
  "Bash(sed:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(echo:*)",
  "Bash(pwd:*)",
  "Bash(file:*)",
  "Bash(date:*)",
  "Bash(jq:*)",
  "Bash(node --check:*)"
]
EOF
      ;;
  esac
}

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
if ! curl -s --connect-timeout 3 --max-time 5 "$DREDD_URL/health" > /dev/null 2>&1; then
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
  # Bound the work to a recent tail of the transcript. On very long
  # sessions (thousands of turns / 100MB+ transcripts) slurping the whole
  # file with `jq -s` costs seconds AND ships every historical prompt to
  # /intent — together blowing the UserPromptSubmit hook's 30s budget as
  # the transcript grows unboundedly. The summary only needs recent
  # context: the latest goal + prior-assistant anchor, the recent tool
  # history (capped at 50 below), and enough recent prompts to seed a
  # cold-session backfill. `tail -n` keeps whole JSONL lines (no mid-line
  # cut) and reads from the end (O(tail), not O(file)); $userPrompts is
  # additionally capped below so the envelope stays small regardless of
  # per-line density.
  local max_lines="${DREDD_TRANSCRIPT_SUMMARY_MAX_LINES:-1200}"
  tail -n "$max_lines" "$tp" 2>/dev/null | jq -s '
    # Walk the recent-tail JSONL array once. Synthetic command markers
    # (<command-name>, <local-command-…>) are filtered out — same
    # predicate the server applies in isSyntheticUserEntry().
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
    # Cap to the most recent prompts (like $toolCalls). The tail already
    # bounds the input, but capping here fixes the envelope size so a
    # dense recent stretch cannot reflate it; the server intent stack
    # only cares about recent (unresolved) goals anyway.
    ([ .[] | select(.type == "user") |
        . as $msg |
        text_of(.message.content) as $raw |
        ($raw | gsub("^\\s+|\\s+$"; "")) as $t |
        images_count_only(.message.content) as $imgs |
        select(is_synthetic($msg; $t) | not) |
        select(($t | length) > 0 or ($imgs | length) > 0) |
        { text: $t, images: $imgs }
    ] | (if length > 60 then .[(length - 60):] else . end)) as $userPrompts |

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
  ' 2>/dev/null
}

# ---------------------------------------------------------------------------
# User-permissions upload helpers.
#
# Reads .permissions.{allow,deny,ask} from the three Claude Code settings
# layers (~/.claude/settings.json, $CWD/.claude/settings.json,
# $CWD/.claude/settings.local.json) and merges them with local > project
# > user precedence (deduped, sorted for a stable hash).
#
# Upload strategy: send the full payload only when the merged hash
# changes, or as a periodic heartbeat (every N prompts / every 24h).
# Otherwise send just the hash so the server reuses the stored copy.
# Cache state file lives at $DREDD_PERM_CACHE_DIR/<project-hash>.json so
# concurrent projects don't collide.
# ---------------------------------------------------------------------------
DREDD_PERM_CACHE_DIR="${DREDD_PERM_CACHE_DIR:-$HOME/.claude/dredd/perm-state}"
mkdir -p "$DREDD_PERM_CACHE_DIR" 2>/dev/null || true

# Belt-and-braces against server-side amnesia (container restart, table
# TTL expiry, etc.) — force a full re-upload every N prompts or every
# 24h even if the hash hasn't changed.
DREDD_PERM_FULL_REUPLOAD_EVERY_N=50
DREDD_PERM_FULL_REUPLOAD_EVERY_SECS=86400

sha256_string() {
  # Portable SHA-256 — macOS ships shasum, Linux ships sha256sum.
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  fi
}

# Merge .permissions.{allow,deny,ask} from up to 3 settings layers.
# Output: compact JSON {allow,deny,ask} on stdout (sorted, deduped) or
# empty string if no readable files OR all 3 lists came back empty (no
# point uploading nothing).
build_user_permissions_payload() {
  local cwd="$1"

  # Read each layer separately so we can apply Dredd-managed subtraction
  # to settings.local.json only — leaving $HOME and project-shared
  # settings.json untouched. Without this per-file approach the
  # reconcile-write to settings.local.json would drift the merged hash
  # every prompt and trigger a full re-upload, defeating the cache.
  local home_perms="{}"
  local proj_perms="{}"
  local local_perms="{}"

  if [ -r "$HOME/.claude/settings.json" ]; then
    home_perms=$(jq -c '.permissions // {}' "$HOME/.claude/settings.json" 2>/dev/null) || home_perms="{}"
  fi
  if [ -n "$cwd" ]; then
    if [ -r "$cwd/.claude/settings.json" ]; then
      proj_perms=$(jq -c '.permissions // {}' "$cwd/.claude/settings.json" 2>/dev/null) || proj_perms="{}"
    fi
    if [ -r "$cwd/.claude/settings.local.json" ]; then
      local_perms=$(jq -c '.permissions // {}' "$cwd/.claude/settings.local.json" 2>/dev/null) || local_perms="{}"
      # Subtract Dredd-managed rules from settings.local.json's view.
      # Sidecar is the source of truth for "what Dredd injected for
      # this session". A user who has manually duplicated a managed
      # rule in their settings.local.json will see it drop from the
      # snapshot — accepted v1 limitation.
      if [ -n "${SESSION_ID:-}" ] && command -v dredd_sidecar_path >/dev/null 2>&1; then
        local _sidecar
        _sidecar=$(dredd_sidecar_path "$cwd" "$SESSION_ID")
        if [ -r "$_sidecar" ]; then
          local _managed
          _managed=$(jq -c '.rulesManaged // []' "$_sidecar" 2>/dev/null)
          if [ -n "$_managed" ] && [ "$_managed" != "[]" ]; then
            local_perms=$(printf '%s' "$local_perms" \
              | jq -c --argjson m "$_managed" '
                  .allow = ((.allow // []) - $m)
                ' 2>/dev/null) || local_perms="{}"
          fi
        fi
      fi
    fi
  fi

  local merged
  merged=$(jq -nc \
    --argjson h "$home_perms" \
    --argjson p "$proj_perms" \
    --argjson l "$local_perms" \
    '{
      allow: ([($h.allow // []), ($p.allow // []), ($l.allow // [])] | add | unique),
      deny:  ([($h.deny  // []), ($p.deny  // []), ($l.deny  // [])] | add | unique),
      ask:   ([($h.ask   // []), ($p.ask   // []), ($l.ask   // [])] | add | unique)
    }' 2>/dev/null)

  [ -z "$merged" ] && return
  local total
  total=$(printf '%s' "$merged" | jq '(.allow | length) + (.deny | length) + (.ask | length)' 2>/dev/null)
  [ "${total:-0}" = "0" ] && return
  printf '%s' "$merged"
}

perm_cache_path() {
  local cwd="$1"
  local key=""
  if [ -n "$cwd" ]; then
    key=$(sha256_string "$cwd")
  fi
  echo "$DREDD_PERM_CACHE_DIR/${key:-default}.json"
}

# Populates globals CACHED_HASH / CACHED_COUNTER / CACHED_LAST_FULL_AT
# from the cache state file. All-zero defaults when the file is absent.
read_perm_cache() {
  local cache_file="$1"
  CACHED_HASH=""
  CACHED_COUNTER=0
  CACHED_LAST_FULL_AT=0
  if [ -r "$cache_file" ]; then
    CACHED_HASH=$(jq -r '.hash // ""' "$cache_file" 2>/dev/null)
    CACHED_COUNTER=$(jq -r '.promptsSinceFullUpload // 0' "$cache_file" 2>/dev/null)
    CACHED_LAST_FULL_AT=$(jq -r '.lastFullUploadAt // 0' "$cache_file" 2>/dev/null)
  fi
}

write_perm_cache() {
  local cache_file="$1" hash="$2" counter="$3" last_full="$4"
  jq -n \
    --arg hash "$hash" \
    --argjson counter "$counter" \
    --argjson last_full "$last_full" \
    '{
      hash: $hash,
      promptsSinceFullUpload: $counter,
      lastFullUploadAt: $last_full
    }' > "$cache_file" 2>/dev/null
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

    # Phase 7c — sweep stale sidecars from crashed sessions before we
    # do anything else. Default stale window is 24h; tunable via
    # DREDD_MANAGED_SIDECAR_STALE_SECS for tests / fast cycles.
    DREDD_MANAGED_SIDECAR_STALE_SECS="${DREDD_MANAGED_SIDECAR_STALE_SECS:-86400}"
    if command -v dredd_sweep_stale_sidecars >/dev/null 2>&1; then
      dredd_sweep_stale_sidecars "$DREDD_MANAGED_SIDECAR_STALE_SECS" \
        >/dev/null 2>>"$DREDD_DEBUG_LOG" || true
    fi

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

    # User-permissions snapshot. Always send the hash when we have
    # readable settings; send the full {allow,deny,ask} payload only
    # when the hash changed since last upload or on the periodic
    # heartbeat. Server-side resync flag clears the cache so the next
    # prompt re-sends the full payload.
    USER_PERM_HASH=""
    USER_PERM_PAYLOAD_JSON=""
    USER_PERM_FULL_SENT=0
    PERM_CACHE_FILE=""
    NOW_EPOCH=$(date +%s)
    CACHED_HASH=""
    CACHED_COUNTER=0
    CACHED_LAST_FULL_AT=0
    USER_PERM_PAYLOAD=$(build_user_permissions_payload "$CWD")
    if [ -n "$USER_PERM_PAYLOAD" ]; then
      USER_PERM_HASH=$(sha256_string "$USER_PERM_PAYLOAD")
      PERM_CACHE_FILE=$(perm_cache_path "$CWD")
      read_perm_cache "$PERM_CACHE_FILE"
      SECS_SINCE_FULL=$((NOW_EPOCH - CACHED_LAST_FULL_AT))
      # Trigger a full upload when: no prior state, hash changed,
      # we've sent N hash-only uploads in a row, or 24h+ since last
      # full upload (server-side TTL hedge).
      if [ -z "$CACHED_HASH" ] \
        || [ "$CACHED_HASH" != "$USER_PERM_HASH" ] \
        || [ "$CACHED_COUNTER" -ge "$DREDD_PERM_FULL_REUPLOAD_EVERY_N" ] \
        || [ "$SECS_SINCE_FULL" -ge "$DREDD_PERM_FULL_REUPLOAD_EVERY_SECS" ]; then
        USER_PERM_PAYLOAD_JSON="$USER_PERM_PAYLOAD"
        USER_PERM_FULL_SENT=1
      fi
    fi

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

    # Merge user-permissions fields into the request body. Always
    # attaches user_permissions_hash when we have one; only attaches
    # the full user_permissions object on full uploads.
    if [ -n "$USER_PERM_HASH" ]; then
      REQ_BODY_TMP=$(mktemp -t dredd-intent-req2.XXXXXX)
      if [ -n "$USER_PERM_PAYLOAD_JSON" ]; then
        jq --arg h "$USER_PERM_HASH" --argjson up "$USER_PERM_PAYLOAD_JSON" \
          '. + {user_permissions_hash: $h, user_permissions: $up}' \
          "$REQ_BODY_FILE" > "$REQ_BODY_TMP" 2>/dev/null && \
          mv "$REQ_BODY_TMP" "$REQ_BODY_FILE" || rm -f "$REQ_BODY_TMP"
      else
        jq --arg h "$USER_PERM_HASH" \
          '. + {user_permissions_hash: $h}' \
          "$REQ_BODY_FILE" > "$REQ_BODY_TMP" 2>/dev/null && \
          mv "$REQ_BODY_TMP" "$REQ_BODY_FILE" || rm -f "$REQ_BODY_TMP"
      fi
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
      # Update permission cache state on a successful upload. The
      # server's user_permissions_resync flag means "I don't have the
      # lists for this (user, project); send the full payload next
      # time" — we honour it by clearing the cache file, so the next
      # /intent unconditionally uploads.
      if [ -n "$USER_PERM_HASH" ] && [ -n "$PERM_CACHE_FILE" ]; then
        RESYNC=$(jq -r '.user_permissions_resync // false' "$INTENT_BODY_FILE" 2>/dev/null)
        if [ "$RESYNC" = "true" ]; then
          rm -f "$PERM_CACHE_FILE" 2>/dev/null || true
        elif [ "$USER_PERM_FULL_SENT" = "1" ]; then
          write_perm_cache "$PERM_CACHE_FILE" "$USER_PERM_HASH" 0 "$NOW_EPOCH"
        else
          write_perm_cache "$PERM_CACHE_FILE" "$USER_PERM_HASH" \
            $((CACHED_COUNTER + 1)) "$CACHED_LAST_FULL_AT"
        fi
      fi
      # Extract just the hook fields (systemMessage etc), strip _meta.
      jq 'del(._meta, .user_permissions_resync)' "$INTENT_BODY_FILE" 2>/dev/null || echo '{}'
    fi
    rm -f "$INTENT_BODY_FILE" "$REQ_BODY_FILE" "$SUMMARY_FILE" 2>/dev/null || true

    # Phase 7b — Managed-allow reconciliation. Runs only after we've
    # confirmed Dredd is reachable (the /health check at the top of the
    # script gated us here), and only when both CWD and SESSION_ID are
    # known. Silent on missing fields and on jq/IO errors — the
    # managed-allow feature is advisory; failures don't block prompts.
    if [ -n "$CWD" ] && [ -n "$SESSION_ID" ] && command -v dredd_reconcile_managed_allow >/dev/null 2>&1; then
      DESIRED_RULES_JSON=$(_dredd_rules_for_scope "$DREDD_MANAGED_ALLOW_SCOPE")
      if [ -n "$DESIRED_RULES_JSON" ]; then
        dredd_reconcile_managed_allow "$CWD" "$SESSION_ID" \
          "$DREDD_MANAGED_ALLOW_SCOPE" "$DESIRED_RULES_JSON" \
          >/dev/null 2>>"${DREDD_DEBUG_LOG:-$HOME/.claude/dredd/hook-debug.log}" || true
      fi
    fi
    ;;

  "PreToolUse")
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
    TOOL_INPUT=$(echo "$INPUT" | jq '.tool_input // {}')
    # tool_use_id is Claude's per-call identifier (e.g. toolu_*). Same
    # value reappears in PostToolUse, which lets the server stitch
    # together pre- and post-execution records for one call. We pass
    # it through unchanged.
    TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
    TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
    # Live working directory of this tool call. Claude Code includes `cwd` in
    # every hook payload; forwarding it lets the server resolve relative `rm`
    # targets against where the command runs (in-project vs system path).
    CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

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
        --arg tuid "$TOOL_USE_ID" \
        --arg ar "$AGENT_REASONING" \
        --arg tp "$TRANSCRIPT_PATH" \
        --arg mode "$DREDD_MODE" \
        --arg cwd "$CWD" \
        --slurpfile sum "$EVAL_SUMMARY_FILE" \
        '{
          session_id: $sid,
          tool_name: $tn,
          tool_input: $ti,
          tool_use_id: (if $tuid == "" then null else $tuid end),
          agent_reasoning: $ar,
          transcript_path: (if $tp == "" then null else $tp end),
          transcript_summary: ($sum | first),
          cwd: (if $cwd == "" then null else $cwd end),
          mode: (if $mode == "" then null else $mode end)
        }' >"$EVAL_REQ_FILE"
    else
      jq -n \
        --arg sid "$SESSION_ID" \
        --arg tn "$TOOL_NAME" \
        --argjson ti "$TOOL_INPUT" \
        --arg tuid "$TOOL_USE_ID" \
        --arg ar "$AGENT_REASONING" \
        --arg tp "$TRANSCRIPT_PATH" \
        --arg mode "$DREDD_MODE" \
        --arg cwd "$CWD" \
        '{
          session_id: $sid,
          tool_name: $tn,
          tool_input: $ti,
          tool_use_id: (if $tuid == "" then null else $tuid end),
          agent_reasoning: $ar,
          transcript_path: (if $tp == "" then null else $tp end),
          cwd: (if $cwd == "" then null else $cwd end),
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
    TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
    TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // empty' | head -c 5000)

    # Compose to a tempfile + --data-binary @file for the same
    # ARG_MAX safety reason as /intent (a 100KB Bash output via
    # `-d "$(...)"` would also get clipped).
    TRACK_REQ_FILE=$(mktemp -t dredd-track.XXXXXX)
    jq -n \
      --arg sid "$SESSION_ID" \
      --arg tn "$TOOL_NAME" \
      --argjson ti "$TOOL_INPUT" \
      --arg tuid "$TOOL_USE_ID" \
      --arg to "$TOOL_OUTPUT" \
      '{
        session_id: $sid,
        tool_name: $tn,
        tool_input: $ti,
        tool_use_id: (if $tuid == "" then null else $tuid end),
        tool_output: $to
      }' >"$TRACK_REQ_FILE"

    # Async — fire and forget, don't block the agent. The trailing
    # `; rm` runs in the background subshell so the tempfile is
    # cleaned up after curl exits, regardless of whether the request
    # succeeds.
    ( curl -s -X POST "$DREDD_URL/track" \
        "${DREDD_CURL_ARGS[@]}" \
        -H "Content-Type: application/json" \
        --data-binary "@$TRACK_REQ_FILE" \
        --connect-timeout 2 --max-time 5 > /dev/null 2>&1
      rm -f "$TRACK_REQ_FILE" 2>/dev/null || true
    ) &

    echo '{}'
    ;;

  "PostToolUseFailure")
    # A tool call that Dredd allowed at PreToolUse FAILED at runtime.
    # Claude Code routes failures here instead of PostToolUse, so without
    # this branch failed calls are invisible to Dredd — and repeated failed
    # exec/egress attempts are exactly the probing behaviour the judge
    # should see. POST to /track with is_error=true: the server records the
    # failure as the call's outcome but skips file/env accumulation (the
    # side effects never happened) and skips approval promotion (a failure
    # is not user consent).
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
    TOOL_INPUT=$(echo "$INPUT" | jq '.tool_input // {}')
    TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
    # Error text lives under a few possible keys across CC versions; take
    # the first non-empty. Cap to keep the row small.
    TOOL_ERROR=$(echo "$INPUT" | jq -r '.tool_error // .error // (.tool_response.error?) // empty' | head -c 5000)

    FAIL_REQ_FILE=$(mktemp -t dredd-fail.XXXXXX)
    jq -n \
      --arg sid "$SESSION_ID" \
      --arg tn "$TOOL_NAME" \
      --argjson ti "$TOOL_INPUT" \
      --arg tuid "$TOOL_USE_ID" \
      --arg te "$TOOL_ERROR" \
      '{
        session_id: $sid,
        tool_name: $tn,
        tool_input: $ti,
        tool_use_id: (if $tuid == "" then null else $tuid end),
        is_error: true,
        tool_error: $te
      }' >"$FAIL_REQ_FILE"

    ( curl -s -X POST "$DREDD_URL/track" \
        "${DREDD_CURL_ARGS[@]}" \
        -H "Content-Type: application/json" \
        --data-binary "@$FAIL_REQ_FILE" \
        --connect-timeout 2 --max-time 5 > /dev/null 2>&1
      rm -f "$FAIL_REQ_FILE" 2>/dev/null || true
    ) &

    echo '{}'
    ;;

  "PermissionDenied")
    # Decision capture: the USER refused a permission prompt, so the tool
    # never ran. Without this branch a refusal is invisible to Dredd —
    # indistinguishable from a call that was never asked about. POST to
    # /track with user_decision=deny: the server records the refusal as
    # the call's outcome (paired by tool_use_id) and drops the pending
    # approval candidate WITHOUT promoting it. Server-side this is gated
    # on DREDD_DECISION_CAPTURE_ENABLED; with the flag off the POST is a
    # no-op, so this branch is always safe to ship. Fire-and-forget.
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
    TOOL_INPUT=$(echo "$INPUT" | jq '.tool_input // {}')
    TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
    # Denial detail across CC versions/sources; first non-empty, capped.
    DENY_REASON=$(echo "$INPUT" | jq -r '.reason // .denial_reason // .message // empty' | head -c 2000)

    DENY_REQ_FILE=$(mktemp -t dredd-deny.XXXXXX)
    jq -n \
      --arg sid "$SESSION_ID" \
      --arg tn "$TOOL_NAME" \
      --argjson ti "$TOOL_INPUT" \
      --arg tuid "$TOOL_USE_ID" \
      --arg dr "$DENY_REASON" \
      '{
        session_id: $sid,
        tool_name: $tn,
        tool_input: $ti,
        tool_use_id: (if $tuid == "" then null else $tuid end),
        user_decision: "deny",
        deny_reason: $dr
      }' >"$DENY_REQ_FILE"

    ( curl -s -X POST "$DREDD_URL/track" \
        "${DREDD_CURL_ARGS[@]}" \
        -H "Content-Type: application/json" \
        --data-binary "@$DENY_REQ_FILE" \
        --connect-timeout 2 --max-time 5 > /dev/null 2>&1
      rm -f "$DENY_REQ_FILE" 2>/dev/null || true
    ) &

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

    # Phase 7c — strip Dredd-managed allow rules from settings.local.json
    # for any project this session was managing (typically just one). If
    # other sessions are still active on the same project, the rules
    # stay; only the sidecar for this session is removed. Best-effort.
    if [ -n "$SESSION_ID" ] && command -v dredd_cleanup_session >/dev/null 2>&1; then
      dredd_cleanup_session "$SESSION_ID" \
        >/dev/null 2>>"${DREDD_DEBUG_LOG:-$HOME/.claude/dredd/hook-debug.log}" || true
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

  "InstructionsLoaded")
    # A CLAUDE.md / .claude/rules/*.md file entered the agent's context.
    # Instruction files are a goal-hijack channel (a malicious repo's
    # CLAUDE.md can redirect the agent) and the judge — which runs in clean
    # context — never sees them. Record the load so Dredd can surface it and
    # (behind DREDD_INSTRUCTIONS_EVIDENCE_ENABLED) feed it to the judge as
    # soft evidence. Fire-and-forget — informational, never blocks.
    FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // empty')
    LOAD_REASON=$(echo "$INPUT" | jq -r '.load_reason // empty')
    if [ -n "$FILE_PATH" ]; then
      curl -s -X POST "$DREDD_URL/instructions" \
        "${DREDD_CURL_ARGS[@]}" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg sid "$SESSION_ID" --arg fp "$FILE_PATH" --arg lr "$LOAD_REASON" \
              '{session_id: $sid, file_path: $fp, load_reason: $lr}')" \
        --connect-timeout 2 --max-time 5 > /dev/null 2>&1 &
    fi

    echo '{}'
    ;;

  *)
    echo '{}'
    ;;
esac
