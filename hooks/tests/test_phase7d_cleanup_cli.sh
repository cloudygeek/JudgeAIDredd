#!/bin/bash
# =============================================================================
# Tests for hooks/dredd-cleanup.sh (Phase 7d companion).
#
# Run: ./hooks/tests/test_phase7d_cleanup_cli.sh
# =============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="$(cd "$HERE/.." && pwd)/dredd-cleanup.sh"
PRIMS="$(cd "$HERE/.." && pwd)/dredd-managed-allow.sh"

c_green='\033[32m'
c_red='\033[31m'
c_dim='\033[2m'
c_off='\033[0m'

PASS=0
FAIL=0
pass() { printf "  ${c_green}✓${c_off} %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  ${c_red}✗${c_off} %s\n" "$1"; FAIL=$((FAIL+1)); }
section() { printf "\n${c_dim}---${c_off} %s ${c_dim}---${c_off}\n" "$1"; }

TMP=$(mktemp -d -t dredd-phase7d.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

export DREDD_MANAGED_DIR="$TMP/managed"
mkdir -p "$DREDD_MANAGED_DIR"

# Source the primitives so the tests can set up state directly.
# shellcheck disable=SC1090
. "$PRIMS"

# -----------------------------------------------------------------------------
section "--help and unknown flags"

OUT=$("$TOOL" --help)
echo "$OUT" | grep -q '^Usage:' && pass "--help prints usage line" || fail "no Usage: line"
echo "$OUT" | grep -q '\-\-project' && pass "--help mentions --project" || fail "no --project in help"

"$TOOL" --garbage >/dev/null 2>&1
[ $? -ne 0 ] && pass "unknown flag exits non-zero" || fail "unknown flag returned 0"

# -----------------------------------------------------------------------------
section "Nothing to do (no sidecars)"

OUT=$("$TOOL" --project "$TMP/nonexistent" --yes 2>&1)
echo "$OUT" | grep -qi 'No Dredd-managed sidecars' && pass "reports empty cleanly" \
  || fail "expected empty message, got: $OUT"

# -----------------------------------------------------------------------------
section "--project mode strips rules + removes only that project's sidecars"

PROJ_A="$TMP/proj-A"
PROJ_B="$TMP/proj-B"
mkdir -p "$PROJ_A/.claude" "$PROJ_B/.claude"
echo '{"permissions":{"allow":["Bash(my-tool:*)"]}}' > "$PROJ_A/.claude/settings.local.json"
echo '{"permissions":{"allow":["Bash(other:*)"]}}' > "$PROJ_B/.claude/settings.local.json"

dredd_reconcile_managed_allow "$PROJ_A" "sess-A1" "conservative" '["Read","Bash(awk:*)"]'
dredd_reconcile_managed_allow "$PROJ_B" "sess-B1" "conservative" '["Read"]'

"$TOOL" --project "$PROJ_A" --yes >/dev/null
ALLOW_A=$(jq -c '.permissions.allow' "$PROJ_A/.claude/settings.local.json")
[ "$ALLOW_A" = '["Bash(my-tool:*)"]' ] && pass "proj-A user rule survives, managed gone" \
  || fail "proj-A: $ALLOW_A"
SP_A=$(dredd_sidecar_path "$PROJ_A" "sess-A1")
[ ! -f "$SP_A" ] && pass "proj-A sidecar removed" || fail "proj-A sidecar still exists"

ALLOW_B=$(jq -c '.permissions.allow | sort' "$PROJ_B/.claude/settings.local.json")
echo "$ALLOW_B" | jq -e '. | contains(["Bash(other:*)","Read"])' >/dev/null \
  && pass "proj-B untouched by proj-A cleanup" \
  || fail "proj-B disturbed: $ALLOW_B"

# -----------------------------------------------------------------------------
section "--dry-run leaves files untouched"

# Re-seed proj-A.
echo '{"permissions":{"allow":["Bash(my-tool:*)"]}}' > "$PROJ_A/.claude/settings.local.json"
dredd_reconcile_managed_allow "$PROJ_A" "sess-A2" "conservative" '["Read","Bash(awk:*)"]'
BEFORE=$(jq -c '.permissions.allow | sort' "$PROJ_A/.claude/settings.local.json")
OUT=$("$TOOL" --project "$PROJ_A" --dry-run 2>&1)
AFTER=$(jq -c '.permissions.allow | sort' "$PROJ_A/.claude/settings.local.json")
[ "$BEFORE" = "$AFTER" ] && pass "dry-run leaves settings.local.json untouched" \
  || fail "settings changed: $BEFORE → $AFTER"
SP_A2=$(dredd_sidecar_path "$PROJ_A" "sess-A2")
[ -f "$SP_A2" ] && pass "dry-run leaves sidecar in place" || fail "sidecar removed by dry-run"
echo "$OUT" | grep -q "dry-run" && pass "dry-run output mentions 'dry-run'" \
  || fail "no dry-run marker in output: $OUT"

# -----------------------------------------------------------------------------
section "Refcount safety: two sessions, --project cleans only its sidecar"

# Reset.
"$TOOL" --all --yes --quiet >/dev/null 2>&1
echo '{"permissions":{"allow":["Bash(my-tool:*)"]}}' > "$PROJ_A/.claude/settings.local.json"

dredd_reconcile_managed_allow "$PROJ_A" "sess-X" "conservative" '["Read","Bash(awk:*)"]'
dredd_reconcile_managed_allow "$PROJ_A" "sess-Y" "conservative" '["Read","Bash(awk:*)"]'

"$TOOL" --project "$PROJ_A" --yes >/dev/null
# Both sidecars belong to proj-A → both are targets → both deleted → both
# sessions had their rules tracked, so after deletion no sidecars remain
# for proj-A, and the LAST one to be processed should trigger the strip.
ALLOW=$(jq -c '.permissions.allow' "$PROJ_A/.claude/settings.local.json")
[ "$ALLOW" = '["Bash(my-tool:*)"]' ] && pass "after --project: managed rules stripped (last sidecar's processing triggered it)" \
  || fail "expected user rule only, got $ALLOW"
SP_X=$(dredd_sidecar_path "$PROJ_A" "sess-X")
SP_Y=$(dredd_sidecar_path "$PROJ_A" "sess-Y")
[ ! -f "$SP_X" ] && [ ! -f "$SP_Y" ] && pass "both sidecars deleted" \
  || fail "sidecar(s) survived: X=$([ -f "$SP_X" ] && echo PRESENT || echo gone) Y=$([ -f "$SP_Y" ] && echo PRESENT || echo gone)"

# -----------------------------------------------------------------------------
section "--all touches every project"

# Reset.
rm -rf "$DREDD_MANAGED_DIR" && mkdir -p "$DREDD_MANAGED_DIR"
echo '{"permissions":{"allow":["Bash(my-tool:*)"]}}' > "$PROJ_A/.claude/settings.local.json"
echo '{"permissions":{"allow":["Bash(other:*)"]}}' > "$PROJ_B/.claude/settings.local.json"

dredd_reconcile_managed_allow "$PROJ_A" "sess-aa" "conservative" '["Read"]'
dredd_reconcile_managed_allow "$PROJ_B" "sess-bb" "conservative" '["Read","Bash(awk:*)"]'

"$TOOL" --all --yes >/dev/null
ALLOW_A=$(jq -c '.permissions.allow' "$PROJ_A/.claude/settings.local.json")
ALLOW_B=$(jq -c '.permissions.allow' "$PROJ_B/.claude/settings.local.json")
[ "$ALLOW_A" = '["Bash(my-tool:*)"]' ] && pass "--all stripped proj-A managed rules" \
  || fail "proj-A: $ALLOW_A"
[ "$ALLOW_B" = '["Bash(other:*)"]' ] && pass "--all stripped proj-B managed rules" \
  || fail "proj-B: $ALLOW_B"

# Managed dir should now be empty of .json sidecars (manage.log may
# remain).
COUNT=$(ls "$DREDD_MANAGED_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
[ "$COUNT" = "0" ] && pass "no sidecars remain after --all" \
  || fail "$COUNT sidecar(s) survived --all"

# -----------------------------------------------------------------------------
section "Defensive: unparseable sidecar is deleted"

BAD="$DREDD_MANAGED_DIR/junk.json"
echo 'not valid json' > "$BAD"
"$TOOL" --all --yes >/dev/null
[ ! -f "$BAD" ] && pass "unparseable sidecar deleted" || fail "junk.json still exists"

# -----------------------------------------------------------------------------
section "Non-tty stdin skips the interactive prompt"

# Re-seed.
echo '{"permissions":{"allow":["Bash(my-tool:*)"]}}' > "$PROJ_A/.claude/settings.local.json"
dredd_reconcile_managed_allow "$PROJ_A" "sess-pipe" "conservative" '["Read"]'

# Pipe an empty string to stdin — should NOT prompt, should run cleanup.
OUT=$(echo "" | "$TOOL" --project "$PROJ_A")
ALLOW=$(jq -c '.permissions.allow' "$PROJ_A/.claude/settings.local.json")
[ "$ALLOW" = '["Bash(my-tool:*)"]' ] && pass "non-tty stdin auto-confirms cleanup" \
  || fail "cleanup didn't run via pipe: $ALLOW"

# -----------------------------------------------------------------------------
printf "\n  %d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
