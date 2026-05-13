#!/bin/bash
# =============================================================================
# Tests for hooks/dredd-managed-allow.sh — Phase 7a primitives.
#
# Run: ./hooks/tests/test_phase7a_managed_allow.sh
# Exits non-zero on any failure.
# =============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$(cd "$HERE/.." && pwd)/dredd-managed-allow.sh"

c_green='\033[32m'
c_red='\033[31m'
c_dim='\033[2m'
c_off='\033[0m'

PASS=0
FAIL=0
pass() { printf "  ${c_green}✓${c_off} %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  ${c_red}✗${c_off} %s\n" "$1"; FAIL=$((FAIL+1)); }
section() { printf "\n${c_dim}---${c_off} %s ${c_dim}---${c_off}\n" "$1"; }

# Isolated managed dir per run.
TMP=$(mktemp -d -t dredd-phase7a.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

export DREDD_MANAGED_DIR="$TMP/managed"
mkdir -p "$DREDD_MANAGED_DIR"

# shellcheck disable=SC1090
. "$SUT"

# -----------------------------------------------------------------------------
section "Path helpers"

DM=$(dredd_managed_dir)
[ "$DM" = "$DREDD_MANAGED_DIR" ] && pass "dredd_managed_dir respects env override" \
  || fail "expected '$DREDD_MANAGED_DIR' got '$DM'"

P1=$(dredd_sidecar_path "/proj/foo" "sess-1")
P2=$(dredd_sidecar_path "/proj/foo" "sess-1")
[ "$P1" = "$P2" ] && pass "sidecar path is stable for same (project, session)" \
  || fail "stability: $P1 vs $P2"

P3=$(dredd_sidecar_path "/proj/bar" "sess-1")
[ "$P1" != "$P3" ] && pass "different project → different sidecar path" \
  || fail "collision: $P1"

P4=$(dredd_sidecar_path "/proj/foo" "sess-2")
[ "$P1" != "$P4" ] && pass "different session → different sidecar path" \
  || fail "collision: $P1 vs $P4"

PSAFE_BASENAME=$(basename "$(dredd_sidecar_path "/proj/foo" "weird/session/id..!")")
# Basename must not contain '/', '!', or any whitespace — only [A-Za-z0-9._-]
# from the projectHash, the literal '--' separator, the sanitised sessionId,
# and the .json suffix.
echo "$PSAFE_BASENAME" | grep -qE '^[A-Za-z0-9._-]+--[A-Za-z0-9._-]+\.json$' \
  && pass "sessionId sanitisation produces safe filename: $PSAFE_BASENAME" \
  || fail "sanitised basename unsafe: $PSAFE_BASENAME"

SLP=$(dredd_settings_local_path "/proj/foo")
[ "$SLP" = "/proj/foo/.claude/settings.local.json" ] && pass "settings.local.json path" \
  || fail "settings path: $SLP"

# -----------------------------------------------------------------------------
section "Sidecar write → read round-trip"

PROJ_ROOT="$TMP/projects/alpha"
mkdir -p "$PROJ_ROOT/.claude"
RULES='["Bash(awk:*)","Read"]'
dredd_sidecar_write "$PROJ_ROOT" "sess-A" "conservative" "$RULES" && pass "sidecar_write succeeded" \
  || fail "sidecar_write returned non-zero"

SP=$(dredd_sidecar_path "$PROJ_ROOT" "sess-A")
[ -f "$SP" ] && pass "sidecar file created at expected path" || fail "no file at $SP"

dredd_sidecar_read "$SP"
[ "$SIDECAR_SCOPE" = "conservative" ] && pass "scope round-trips" \
  || fail "scope: '$SIDECAR_SCOPE'"
[ "$(echo "$SIDECAR_RULES" | jq -c .)" = '["Bash(awk:*)","Read"]' ] && pass "rules round-trip" \
  || fail "rules: $SIDECAR_RULES"
[ -n "$SIDECAR_CREATED" ] && pass "createdAt set" || fail "createdAt empty"
[ -n "$SIDECAR_TOUCHED" ] && pass "lastTouched set" || fail "lastTouched empty"
[ "$SIDECAR_PROJECT_ROOT" = "$PROJ_ROOT" ] && pass "projectRoot round-trips" \
  || fail "projectRoot: $SIDECAR_PROJECT_ROOT"

# Re-write should preserve createdAt and advance lastTouched.
FIRST_CREATED="$SIDECAR_CREATED"
FIRST_TOUCHED="$SIDECAR_TOUCHED"
sleep 1
dredd_sidecar_write "$PROJ_ROOT" "sess-A" "conservative" '["Bash(awk:*)","Read","Write"]'
dredd_sidecar_read "$SP"
[ "$SIDECAR_CREATED" = "$FIRST_CREATED" ] && pass "createdAt preserved across re-writes" \
  || fail "createdAt changed: $FIRST_CREATED → $SIDECAR_CREATED"
[ "$SIDECAR_TOUCHED" != "$FIRST_TOUCHED" ] && pass "lastTouched advances on re-write" \
  || fail "lastTouched didn't advance ($SIDECAR_TOUCHED)"

# Delete.
dredd_sidecar_delete "$SP"
[ ! -f "$SP" ] && pass "sidecar_delete removes the file" || fail "file still exists"

# Read missing sidecar → returns non-zero, globals reset.
if dredd_sidecar_read "$SP"; then
  fail "sidecar_read should fail on missing file"
else
  [ "$SIDECAR_RULES" = "[]" ] && pass "read missing → SIDECAR_RULES reset to '[]'" \
    || fail "SIDECAR_RULES not reset: $SIDECAR_RULES"
fi

# -----------------------------------------------------------------------------
section "dredd_project_has_other_sidecars"

# Fresh managed dir state.
rm -rf "$DREDD_MANAGED_DIR" && mkdir -p "$DREDD_MANAGED_DIR"

# Two sidecars for project alpha, one for project beta.
dredd_sidecar_write "$PROJ_ROOT" "sess-A" "x" '[]'
dredd_sidecar_write "$PROJ_ROOT" "sess-B" "x" '[]'
dredd_sidecar_write "$TMP/projects/beta" "sess-C" "x" '[]'

# Looking for "other than sess-A" → sess-B exists → 0 (yes)
if dredd_project_has_other_sidecars "$PROJ_ROOT" "sess-A"; then
  pass "alpha has other sidecars when looking from sess-A"
else
  fail "expected other sidecars to exist"
fi

# Remove sess-B; looking from sess-A → 1 (no others)
dredd_sidecar_delete "$(dredd_sidecar_path "$PROJ_ROOT" "sess-B")"
if dredd_project_has_other_sidecars "$PROJ_ROOT" "sess-A"; then
  fail "should report no other sidecars after sess-B deleted"
else
  pass "no other sidecars for alpha once sess-B is gone"
fi

# beta is a different project — alpha's loop shouldn't see beta.
if dredd_project_has_other_sidecars "$PROJ_ROOT" "sess-A"; then
  fail "alpha sees beta's sidecar (cross-project bleed)"
else
  pass "different project's sidecar doesn't count"
fi

# -----------------------------------------------------------------------------
section "settings_add_rules"

PROJ_ROOT2="$TMP/projects/gamma"
mkdir -p "$PROJ_ROOT2"
SLP2=$(dredd_settings_local_path "$PROJ_ROOT2")

# Add to a project with no existing settings.local.json — file should be created.
dredd_settings_add_rules "$PROJ_ROOT2" '["Bash(awk:*)","Read"]' \
  && pass "add_rules succeeded (no existing file)" \
  || fail "add_rules failed"
[ -f "$SLP2" ] && pass "settings.local.json created" || fail "no file at $SLP2"
JSON=$(cat "$SLP2")
ALLOW=$(echo "$JSON" | jq -c '.permissions.allow')
[ "$ALLOW" = '["Bash(awk:*)","Read"]' ] && pass "allow list correct after first add: $ALLOW" \
  || fail "allow wrong: $ALLOW"

# Add overlapping + new rule — must dedup.
dredd_settings_add_rules "$PROJ_ROOT2" '["Read","Write"]'
ALLOW=$(jq -c '.permissions.allow' "$SLP2")
COUNT=$(echo "$ALLOW" | jq 'length')
[ "$COUNT" = "3" ] && pass "dedup: 3 unique entries after overlap add" \
  || fail "expected 3, got $COUNT (allow=$ALLOW)"
echo "$ALLOW" | jq -e '. | contains(["Bash(awk:*)","Read","Write"])' >/dev/null \
  && pass "all 3 expected rules present" \
  || fail "missing entries: $ALLOW"

# Preserve user-added rules and other top-level keys.
cat > "$SLP2" <<'EOF'
{
  "permissions": {
    "allow": ["Bash(npm:*)", "WebFetch(domain:github.com)"]
  },
  "someOtherKey": { "kept": true }
}
EOF
dredd_settings_add_rules "$PROJ_ROOT2" '["Bash(awk:*)","Read"]'
ALLOW=$(jq -c '.permissions.allow' "$SLP2")
echo "$ALLOW" | jq -e '. | contains(["Bash(npm:*)", "WebFetch(domain:github.com)", "Bash(awk:*)", "Read"])' >/dev/null \
  && pass "user rules preserved alongside Dredd-added rules" \
  || fail "user rules lost: $ALLOW"
OK=$(jq '.someOtherKey.kept' "$SLP2")
[ "$OK" = "true" ] && pass "other top-level keys preserved" || fail "lost top-level key: $OK"

# -----------------------------------------------------------------------------
section "settings_remove_rules"

# Remove ONLY the Dredd-added entries. User entries must stay.
dredd_settings_remove_rules "$PROJ_ROOT2" '["Bash(awk:*)","Read"]'
ALLOW=$(jq -c '.permissions.allow' "$SLP2")
COUNT=$(echo "$ALLOW" | jq 'length')
[ "$COUNT" = "2" ] && pass "after remove: 2 entries left (the user's)" \
  || fail "expected 2, got $COUNT (allow=$ALLOW)"
echo "$ALLOW" | jq -e '. | contains(["Bash(npm:*)", "WebFetch(domain:github.com)"])' >/dev/null \
  && pass "user entries Bash(npm:*) + WebFetch(...) survive" \
  || fail "user entries gone: $ALLOW"
echo "$ALLOW" | jq -e '. | contains(["Bash(awk:*)"])' >/dev/null \
  && fail "Bash(awk:*) should be removed but is still present" \
  || pass "Bash(awk:*) removed cleanly"

# Removing a rule that isn't there is a no-op.
dredd_settings_remove_rules "$PROJ_ROOT2" '["Bash(NEVER:*)"]'
ALLOW_AFTER=$(jq -c '.permissions.allow' "$SLP2")
[ "$ALLOW_AFTER" = "$ALLOW" ] && pass "removing absent rule is a no-op" \
  || fail "noop expected, got $ALLOW_AFTER"

# Removing on a project with no settings.local.json at all → no-op, no error.
PROJ_EMPTY="$TMP/projects/empty"
mkdir -p "$PROJ_EMPTY"
dredd_settings_remove_rules "$PROJ_EMPTY" '["Bash(awk:*)"]' \
  && pass "remove on missing file is a no-op (exit 0)" \
  || fail "remove on missing file returned non-zero"

# -----------------------------------------------------------------------------
section "Malformed settings.local.json — fail safe"

PROJ_MAL="$TMP/projects/malformed"
mkdir -p "$PROJ_MAL/.claude"
echo "{ not real json" > "$PROJ_MAL/.claude/settings.local.json"
if dredd_settings_add_rules "$PROJ_MAL" '["X"]'; then
  fail "add should have refused malformed file"
else
  pass "add refuses malformed settings (no clobber)"
fi
# Original malformed content should be intact.
CONTENT=$(cat "$PROJ_MAL/.claude/settings.local.json")
[ "$CONTENT" = "{ not real json" ] && pass "original malformed file untouched" \
  || fail "file modified despite refusal: $CONTENT"

if dredd_settings_remove_rules "$PROJ_MAL" '["X"]'; then
  fail "remove should have refused malformed file"
else
  pass "remove refuses malformed settings"
fi

# -----------------------------------------------------------------------------
printf "\n  %d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
