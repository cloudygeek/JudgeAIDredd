#!/bin/bash
# =============================================================================
# dredd-managed-allow.sh — primitives for Phase 7's "Dredd manages
# settings.local.json allow rules" feature.
#
# This file defines bash helpers ONLY. No event handling, no health
# checks, no rule-selection logic. Sourced by hooks/dredd-hook.sh in
# Phase 7b onwards. Kept separate so the test suite can source the
# primitives without booting the main hook's case statement.
#
# Concepts:
#   - "Sidecar"           — JSON file under $DREDD_MANAGED_DIR keyed by
#                           (project, session). Records WHAT allow rules
#                           this session contributed to settings.local.json
#                           and WHEN. Source of truth for cleanup.
#   - "settings.local.json" — Claude Code's per-project local permission
#                           config (gitignored). Dredd splices allow
#                           rules in/out of .permissions.allow.
#
# Concurrency note: writes are atomic via mktemp + mv, but two writers
# on the SAME settings.local.json can interleave read-modify-write
# windows. Phase 7b handles reconciliation by re-reading the file on
# every UserPromptSubmit and recomputing the delta.
#
# This file is sourced from hooks/dredd-hook.sh. Do NOT enable `set -u`
# here — the contagion would break the calling hook script, which
# references several optional env vars without guards.
# =============================================================================

DREDD_MANAGED_DIR="${DREDD_MANAGED_DIR:-$HOME/.claude/dredd/managed}"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

dredd_managed_dir() {
  echo "$DREDD_MANAGED_DIR"
}

# 32-char stable project key. Same hashing approach as
# user-permissions-store.ts's projectRootKey, but 32 chars here because
# this key drives a filename (collision-paranoia) rather than a Dynamo
# composite key.
_dredd_project_hash() {
  local projectRoot="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$projectRoot" | shasum -a 256 | awk '{print substr($1, 1, 32)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$projectRoot" | sha256sum | awk '{print substr($1, 1, 32)}'
  fi
}

# Sidecar path: $DREDD_MANAGED_DIR/<projectHash>--<sessionId>.json.
# Sessions are uuid-ish; sanitise just in case.
dredd_sidecar_path() {
  local projectRoot="$1" sessionId="$2"
  local h
  h=$(_dredd_project_hash "$projectRoot")
  local safe_sid
  safe_sid=$(printf '%s' "$sessionId" | tr -c 'A-Za-z0-9._-' '_')
  echo "$DREDD_MANAGED_DIR/${h}--${safe_sid}.json"
}

# Path to a project's .claude/settings.local.json. Doesn't require the
# file to exist — callers handle the create-on-write case.
dredd_settings_local_path() {
  local projectRoot="$1"
  echo "$projectRoot/.claude/settings.local.json"
}

# ---------------------------------------------------------------------------
# Sidecar I/O
# ---------------------------------------------------------------------------

# Create or refresh a sidecar.
# Args: projectRoot sessionId scope rulesArrayJson
# rulesArrayJson MUST be a valid JSON array like '["Bash(awk:*)","Read"]'.
# createdAt is preserved from any existing sidecar; lastTouched is
# always bumped to now. Returns 0 on success, non-zero on jq/IO error.
dredd_sidecar_write() {
  local projectRoot="$1" sessionId="$2" scope="$3" rulesArrayJson="$4"
  local h
  h=$(_dredd_project_hash "$projectRoot")
  local sidecar
  sidecar=$(dredd_sidecar_path "$projectRoot" "$sessionId")
  mkdir -p "$(dirname "$sidecar")" 2>/dev/null || return 1
  local now
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  local existingCreated
  if [ -r "$sidecar" ]; then
    existingCreated=$(jq -r '.createdAt // empty' "$sidecar" 2>/dev/null)
  fi
  local createdAt="${existingCreated:-$now}"
  local tmp
  tmp=$(mktemp -t dredd-sidecar.XXXXXX) || return 1
  jq -n \
    --arg projectRoot "$projectRoot" \
    --arg projectHash "$h" \
    --arg sessionId "$sessionId" \
    --arg scope "$scope" \
    --argjson rules "$rulesArrayJson" \
    --arg createdAt "$createdAt" \
    --arg now "$now" \
    '{
      projectRoot: $projectRoot,
      projectHash: $projectHash,
      sessionId: $sessionId,
      scope: $scope,
      rulesManaged: $rules,
      createdAt: $createdAt,
      lastTouched: $now
    }' > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$sidecar"
}

# Populate globals from a sidecar file. Globals set:
#   SIDECAR_RULES         JSON array string of rulesManaged (or "[]")
#   SIDECAR_SCOPE         scope string (or "")
#   SIDECAR_CREATED       createdAt ISO string (or "")
#   SIDECAR_TOUCHED       lastTouched ISO string (or "")
#   SIDECAR_PROJECT_ROOT  projectRoot string (or "")
# Returns 0 if the sidecar was read, 1 if not found / unparseable.
dredd_sidecar_read() {
  local sidecar="$1"
  SIDECAR_RULES="[]"
  SIDECAR_SCOPE=""
  SIDECAR_CREATED=""
  SIDECAR_TOUCHED=""
  SIDECAR_PROJECT_ROOT=""
  [ -r "$sidecar" ] || return 1
  local parsed
  parsed=$(jq -c '.' "$sidecar" 2>/dev/null) || return 1
  SIDECAR_RULES=$(echo "$parsed" | jq -c '.rulesManaged // []' 2>/dev/null)
  SIDECAR_SCOPE=$(echo "$parsed" | jq -r '.scope // ""' 2>/dev/null)
  SIDECAR_CREATED=$(echo "$parsed" | jq -r '.createdAt // ""' 2>/dev/null)
  SIDECAR_TOUCHED=$(echo "$parsed" | jq -r '.lastTouched // ""' 2>/dev/null)
  SIDECAR_PROJECT_ROOT=$(echo "$parsed" | jq -r '.projectRoot // ""' 2>/dev/null)
}

dredd_sidecar_delete() {
  local sidecar="$1"
  rm -f "$sidecar" 2>/dev/null
}

# Does another sidecar (for a different session) exist for this project?
# Used at session-cleanup time: only strip rules from settings.local.json
# when the last managing sidecar for the project is being removed.
# Returns 0 ("yes, others exist") or 1 ("no others; safe to clean up").
dredd_project_has_other_sidecars() {
  local projectRoot="$1" exceptSessionId="$2"
  local h
  h=$(_dredd_project_hash "$projectRoot")
  [ -d "$DREDD_MANAGED_DIR" ] || return 1
  local exceptPath
  exceptPath=$(dredd_sidecar_path "$projectRoot" "$exceptSessionId")
  local f
  for f in "$DREDD_MANAGED_DIR/${h}--"*.json; do
    [ -e "$f" ] || continue
    [ "$f" = "$exceptPath" ] && continue
    return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# settings.local.json manipulation
# ---------------------------------------------------------------------------

# Splice rules into <projectRoot>/.claude/settings.local.json under
# .permissions.allow. Creates the file (and parent dir) if absent.
# Deduplicates — rules already present are not added twice. Preserves
# any other keys / allow entries verbatim.
# Args: projectRoot rulesArrayJson
dredd_settings_add_rules() {
  local projectRoot="$1" rulesArrayJson="$2"
  local target
  target=$(dredd_settings_local_path "$projectRoot")
  mkdir -p "$(dirname "$target")" 2>/dev/null || return 1
  local source
  if [ -r "$target" ]; then
    if ! jq -e . "$target" >/dev/null 2>&1; then
      # Malformed existing file — refuse rather than clobber.
      return 2
    fi
    source=$(cat "$target")
  else
    source="{}"
  fi
  local tmp
  tmp=$(mktemp -t dredd-settings.XXXXXX) || return 1
  printf '%s' "$source" | jq \
    --argjson add "$rulesArrayJson" \
    '
      .permissions = (.permissions // {})
      | .permissions.allow = (
          ((.permissions.allow // []) + $add)
          | unique
        )
    ' > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$target"
}

# Reconcile the allow rules Dredd manages for (projectRoot, sessionId)
# against the desired set computed from scope. Idempotent.
#
# Algorithm:
#   1. Read prior sidecar → SIDECAR_RULES (rules WE last contributed for
#      this session). Empty array on first call for this session.
#   2. Compute add    = desired - sidecarRules.
#      Compute remove = sidecarRules - desired.
#   3. Apply remove first (so a scope shrink can free up entries before
#      the next add), then add. Both are atomic on disk via mktemp+mv.
#   4. Write/refresh the sidecar with the desired set.
#   5. Append a one-line audit entry to manage.log.
#
# Returns 0 on success, non-zero on jq / IO failure. Best-effort logged
# to stderr so the caller (UserPromptSubmit hook) can drop the failure
# on the floor without blocking the user's prompt.
#
# Args: projectRoot sessionId scope desiredRulesJson
dredd_reconcile_managed_allow() {
  local projectRoot="$1" sessionId="$2" scope="$3" desiredRulesJson="$4"
  [ -z "$projectRoot" ] && return 1
  [ -z "$sessionId" ] && return 1

  # Normalise: sort+dedupe both desired and prior rules so the set
  # arithmetic below is stable across re-orderings.
  local desired
  desired=$(printf '%s' "$desiredRulesJson" | jq -c 'unique' 2>/dev/null) || return 1

  local sidecar
  sidecar=$(dredd_sidecar_path "$projectRoot" "$sessionId")
  local prior="[]"
  if [ -r "$sidecar" ]; then
    dredd_sidecar_read "$sidecar" || true
    prior=$(printf '%s' "$SIDECAR_RULES" | jq -c 'unique' 2>/dev/null) || prior="[]"
  fi

  local toAdd toRemove
  toAdd=$(jq -nc \
    --argjson d "$desired" --argjson p "$prior" \
    '($d - $p)') || return 1
  toRemove=$(jq -nc \
    --argjson d "$desired" --argjson p "$prior" \
    '($p - $d)') || return 1

  local removeCount addCount
  removeCount=$(printf '%s' "$toRemove" | jq 'length' 2>/dev/null)
  addCount=$(printf '%s' "$toAdd" | jq 'length' 2>/dev/null)

  if [ "${removeCount:-0}" -gt 0 ]; then
    if ! dredd_settings_remove_rules "$projectRoot" "$toRemove"; then
      _dredd_managed_log "$projectRoot" "$sessionId" "remove-failed" "$toRemove"
      return 2
    fi
    _dredd_managed_log "$projectRoot" "$sessionId" "remove" "$toRemove"
  fi
  if [ "${addCount:-0}" -gt 0 ]; then
    if ! dredd_settings_add_rules "$projectRoot" "$toAdd"; then
      _dredd_managed_log "$projectRoot" "$sessionId" "add-failed" "$toAdd"
      return 2
    fi
    _dredd_managed_log "$projectRoot" "$sessionId" "add" "$toAdd"
  fi

  dredd_sidecar_write "$projectRoot" "$sessionId" "$scope" "$desired"
}

# Append an audit line to manage.log. Format:
#   <iso-timestamp> <action> sess=<sid> proj=<projectHash> rules=<json>
# Failures are silent — audit must never break the hook.
_dredd_managed_log() {
  local projectRoot="$1" sessionId="$2" action="$3" rulesJson="$4"
  local logFile="$DREDD_MANAGED_DIR/manage.log"
  mkdir -p "$(dirname "$logFile")" 2>/dev/null || return 0
  local now
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  local h
  h=$(_dredd_project_hash "$projectRoot")
  local safe_sid
  safe_sid=$(printf '%s' "$sessionId" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s %s sess=%s proj=%s rules=%s\n' \
    "$now" "$action" "${safe_sid:0:8}" "${h:0:16}" "$rulesJson" \
    >> "$logFile" 2>/dev/null || true
}

# =============================================================================
# Phase 7c — cleanup helpers
# =============================================================================

# Convert ISO-8601 UTC timestamp to epoch seconds. Portable across
# macOS (BSD date) and Linux (GNU date). Prints nothing on parse error.
_dredd_iso_to_epoch() {
  local iso="$1"
  [ -z "$iso" ] && return
  # GNU date — accepts ISO-8601 directly.
  if date -d "$iso" +%s 2>/dev/null; then
    return
  fi
  # BSD date — needs explicit format string.
  date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$iso" +%s 2>/dev/null
}

# SessionEnd cleanup. For every sidecar belonging to sessionId (across
# any project — a Claude session can technically pivot CWD mid-session):
#   - If no OTHER sidecar exists for the same project, strip the
#     sidecar's rulesManaged from that project's settings.local.json.
#   - If others exist, leave settings.local.json alone (refcount via
#     sidecar presence — another live session is still relying on
#     those rules).
#   - Always delete this session's sidecar.
# Best-effort; logs every action to manage.log. Never fatal.
dredd_cleanup_session() {
  local sessionId="$1"
  [ -z "$sessionId" ] && return 0
  [ -d "$DREDD_MANAGED_DIR" ] || return 0
  local safe_sid
  safe_sid=$(printf '%s' "$sessionId" | tr -c 'A-Za-z0-9._-' '_')
  local f
  for f in "$DREDD_MANAGED_DIR"/*--"$safe_sid".json; do
    [ -e "$f" ] || continue
    if ! dredd_sidecar_read "$f"; then
      dredd_sidecar_delete "$f"
      continue
    fi
    local projectRoot="$SIDECAR_PROJECT_ROOT"
    local rules="$SIDECAR_RULES"
    if [ -z "$projectRoot" ]; then
      dredd_sidecar_delete "$f"
      continue
    fi
    if dredd_project_has_other_sidecars "$projectRoot" "$sessionId"; then
      _dredd_managed_log "$projectRoot" "$sessionId" "session-end-skip-others-active" "$rules"
    else
      dredd_settings_remove_rules "$projectRoot" "$rules" 2>/dev/null
      _dredd_managed_log "$projectRoot" "$sessionId" "session-end-remove" "$rules"
    fi
    dredd_sidecar_delete "$f"
  done
}

# Sweep sidecars whose lastTouched is older than staleSecs. Defaults to
# 86400 (24h). For each stale sidecar:
#   - If no other sidecars for the same project, strip its rulesManaged
#     from settings.local.json.
#   - Always delete the stale sidecar.
# Runs at the top of UserPromptSubmit to recover from crashes where a
# session was managing rules but never ran its SessionEnd cleanup.
# Best-effort; per-sidecar failures don't stop the iteration.
dredd_sweep_stale_sidecars() {
  local staleSecs="${1:-86400}"
  [ -d "$DREDD_MANAGED_DIR" ] || return 0
  local now
  now=$(date -u +%s)
  local f
  for f in "$DREDD_MANAGED_DIR"/*.json; do
    [ -e "$f" ] || continue
    if ! dredd_sidecar_read "$f"; then
      continue
    fi
    local touched_epoch
    touched_epoch=$(_dredd_iso_to_epoch "$SIDECAR_TOUCHED")
    [ -z "$touched_epoch" ] && continue
    local age=$((now - touched_epoch))
    if [ "$age" -lt "$staleSecs" ]; then
      continue
    fi
    local projectRoot="$SIDECAR_PROJECT_ROOT"
    local rules="$SIDECAR_RULES"
    local staleSid
    staleSid=$(jq -r '.sessionId // ""' "$f" 2>/dev/null)
    if [ -n "$projectRoot" ] && [ "$rules" != "[]" ]; then
      if dredd_project_has_other_sidecars "$projectRoot" "$staleSid"; then
        _dredd_managed_log "$projectRoot" "$staleSid" "sweep-skip-others-active" "$rules"
      else
        dredd_settings_remove_rules "$projectRoot" "$rules" 2>/dev/null
        _dredd_managed_log "$projectRoot" "$staleSid" "sweep-remove" "$rules"
      fi
    fi
    dredd_sidecar_delete "$f"
  done
}

# Remove rules from <projectRoot>/.claude/settings.local.json
# .permissions.allow. Only removes exact-match entries listed in
# rulesArrayJson — rules added by the user (or other tools) remain.
# No-op when the file doesn't exist. Atomic.
# Args: projectRoot rulesArrayJson
dredd_settings_remove_rules() {
  local projectRoot="$1" rulesArrayJson="$2"
  local target
  target=$(dredd_settings_local_path "$projectRoot")
  [ -r "$target" ] || return 0
  if ! jq -e . "$target" >/dev/null 2>&1; then
    return 2
  fi
  local tmp
  tmp=$(mktemp -t dredd-settings.XXXXXX) || return 1
  jq \
    --argjson rm "$rulesArrayJson" \
    '
      if .permissions.allow then
        .permissions.allow = (.permissions.allow - $rm)
      else . end
    ' "$target" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$target"
}
