#!/bin/bash
# =============================================================================
# Tests for Phase 7c — SessionEnd cleanup + stale-sidecar sweep.
#
# Covers:
#   - dredd_cleanup_session removes rules + sidecar when last session ends
#   - dredd_cleanup_session preserves rules when another sidecar is still active
#   - dredd_sweep_stale_sidecars removes stale sidecars + their rules
#   - sweep leaves fresh sidecars alone
#   - sweep refcount-safe: stale + fresh on same project → fresh keeps rules
#   - user rules survive every cleanup path
#
# Run: ./hooks/tests/test_phase7c_cleanup.sh
# =============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SUT_PRIMS="$(cd "$HERE/.." && pwd)/dredd-managed-allow.sh"
HOOK="$(cd "$HERE/.." && pwd)/dredd-hook.sh"

c_green='\033[32m'
c_red='\033[31m'
c_dim='\033[2m'
c_off='\033[0m'

PASS=0
FAIL=0
pass() { printf "  ${c_green}✓${c_off} %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  ${c_red}✗${c_off} %s\n" "$1"; FAIL=$((FAIL+1)); }
section() { printf "\n${c_dim}---${c_off} %s ${c_dim}---${c_off}\n" "$1"; }

TMP=$(mktemp -d -t dredd-phase7c.XXXXXX)
STUB_PID=""
trap '[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

export DREDD_MANAGED_DIR="$TMP/managed"
mkdir -p "$DREDD_MANAGED_DIR"

# shellcheck disable=SC1090
. "$SUT_PRIMS"

# Set sidecar.lastTouched to a given ISO timestamp.
backdate_sidecar() {
  local sidecar="$1" iso="$2"
  local tmpf
  tmpf=$(mktemp -t dredd-backdate.XXXXXX)
  jq --arg t "$iso" '.lastTouched = $t' "$sidecar" > "$tmpf"
  mv "$tmpf" "$sidecar"
}

# -----------------------------------------------------------------------------
section "dredd_cleanup_session — single-session project"

PROJ_A="$TMP/proj-A"
mkdir -p "$PROJ_A/.claude"
SLP_A="$PROJ_A/.claude/settings.local.json"

# Seed a user-authored rule that must survive cleanup.
echo '{"permissions":{"allow":["Bash(my-tool:*)"]}}' > "$SLP_A"

dredd_reconcile_managed_allow "$PROJ_A" "sess-X" "conservative" '["Read","Bash(awk:*)"]'
ALLOW=$(jq -c '.permissions.allow | sort' "$SLP_A")
echo "$ALLOW" | jq -e '. | length == 3' >/dev/null \
  && pass "after reconcile: 3 rules (user + 2 managed)" \
  || fail "expected 3, got $ALLOW"

# SessionEnd → strip the managed rules, preserve the user's.
dredd_cleanup_session "sess-X"
ALLOW=$(jq -c '.permissions.allow' "$SLP_A")
[ "$ALLOW" = '["Bash(my-tool:*)"]' ] && pass "after cleanup: user rule survives, managed gone" \
  || fail "expected user rule only, got $ALLOW"

# Sidecar should be deleted.
SP=$(dredd_sidecar_path "$PROJ_A" "sess-X")
[ ! -f "$SP" ] && pass "sidecar removed after cleanup" || fail "sidecar still at $SP"

# Calling cleanup again is a no-op (no sidecar, nothing to do).
dredd_cleanup_session "sess-X" && pass "cleanup is idempotent / no-op when no sidecar" \
  || fail "cleanup returned non-zero on no-op"

# -----------------------------------------------------------------------------
section "dredd_cleanup_session — refcount: two sessions on same project"

PROJ_B="$TMP/proj-B"
mkdir -p "$PROJ_B/.claude"
SLP_B="$PROJ_B/.claude/settings.local.json"

dredd_reconcile_managed_allow "$PROJ_B" "sess-Y1" "conservative" '["Read"]'
dredd_reconcile_managed_allow "$PROJ_B" "sess-Y2" "conservative" '["Read","Bash(awk:*)"]'

ALLOW=$(jq -c '.permissions.allow | sort' "$SLP_B")
echo "$ALLOW" | jq -e '. | index("Read") != null and index("Bash(awk:*)") != null' >/dev/null \
  && pass "both rules present after two reconciles" \
  || fail "missing rules: $ALLOW"

# End sess-Y1 → settings.local.json should be UNCHANGED because sess-Y2 is still active.
dredd_cleanup_session "sess-Y1"
ALLOW_AFTER=$(jq -c '.permissions.allow | sort' "$SLP_B")
[ "$ALLOW_AFTER" = "$ALLOW" ] && pass "rules preserved when another session still active" \
  || fail "rules changed: $ALLOW → $ALLOW_AFTER"

SP1=$(dredd_sidecar_path "$PROJ_B" "sess-Y1")
[ ! -f "$SP1" ] && pass "sess-Y1 sidecar deleted" || fail "sess-Y1 sidecar still exists"
SP2=$(dredd_sidecar_path "$PROJ_B" "sess-Y2")
[ -f "$SP2" ] && pass "sess-Y2 sidecar still exists" || fail "sess-Y2 sidecar wrongly removed"

# Now end sess-Y2 → rules should be stripped (no more refs).
dredd_cleanup_session "sess-Y2"
ALLOW=$(jq -c '.permissions.allow' "$SLP_B")
[ "$ALLOW" = "[]" ] && pass "rules stripped after last session ends" \
  || fail "expected [], got $ALLOW"

# -----------------------------------------------------------------------------
section "dredd_sweep_stale_sidecars"

# Fresh managed dir for the sweep tests.
rm -rf "$DREDD_MANAGED_DIR" && mkdir -p "$DREDD_MANAGED_DIR"
PROJ_C="$TMP/proj-C"
mkdir -p "$PROJ_C/.claude"
SLP_C="$PROJ_C/.claude/settings.local.json"

# Two sessions, one stale + one fresh, on DIFFERENT projects so neither blocks the other.
PROJ_D="$TMP/proj-D"
mkdir -p "$PROJ_D/.claude"
SLP_D="$PROJ_D/.claude/settings.local.json"

dredd_reconcile_managed_allow "$PROJ_C" "sess-stale" "conservative" '["Read","Bash(awk:*)"]'
dredd_reconcile_managed_allow "$PROJ_D" "sess-fresh" "conservative" '["Read"]'

# Backdate sess-stale's sidecar to 48h ago.
STALE_SP=$(dredd_sidecar_path "$PROJ_C" "sess-stale")
backdate_sidecar "$STALE_SP" "2026-05-11T00:00:00Z"

# Sweep with default stale window (24h).
dredd_sweep_stale_sidecars 86400

[ ! -f "$STALE_SP" ] && pass "stale sidecar removed by sweep" || fail "stale sidecar survived"
ALLOW=$(jq -c '.permissions.allow' "$SLP_C")
[ "$ALLOW" = "[]" ] && pass "stale session's rules stripped from settings.local.json" \
  || fail "rules still present on proj-C: $ALLOW"

# Fresh sidecar + its rules should be untouched.
FRESH_SP=$(dredd_sidecar_path "$PROJ_D" "sess-fresh")
[ -f "$FRESH_SP" ] && pass "fresh sidecar preserved" || fail "fresh sidecar wrongly removed"
ALLOW=$(jq -c '.permissions.allow | sort' "$SLP_D")
[ "$ALLOW" = '["Read"]' ] && pass "fresh session's rules preserved" \
  || fail "fresh rules disturbed: $ALLOW"

# -----------------------------------------------------------------------------
section "Sweep refcount safety: stale + fresh on SAME project"

rm -rf "$DREDD_MANAGED_DIR" && mkdir -p "$DREDD_MANAGED_DIR"
PROJ_E="$TMP/proj-E"
mkdir -p "$PROJ_E/.claude"
SLP_E="$PROJ_E/.claude/settings.local.json"

dredd_reconcile_managed_allow "$PROJ_E" "sess-old" "conservative" '["Read","Bash(awk:*)"]'
dredd_reconcile_managed_allow "$PROJ_E" "sess-new" "conservative" '["Read","Bash(awk:*)"]'

OLD_SP=$(dredd_sidecar_path "$PROJ_E" "sess-old")
backdate_sidecar "$OLD_SP" "2026-05-11T00:00:00Z"

dredd_sweep_stale_sidecars 86400

[ ! -f "$OLD_SP" ] && pass "stale sidecar deleted even when fresh sibling exists" \
  || fail "stale sidecar survived"
NEW_SP=$(dredd_sidecar_path "$PROJ_E" "sess-new")
[ -f "$NEW_SP" ] && pass "fresh sibling sidecar preserved" || fail "fresh sibling lost"
ALLOW=$(jq -c '.permissions.allow | sort' "$SLP_E")
echo "$ALLOW" | jq -e '. | length == 2' >/dev/null \
  && pass "settings.local.json rules NOT stripped (fresh session still managing them)" \
  || fail "rules wrongly stripped: $ALLOW"

# Audit log should show a sweep-skip-others-active entry.
LOG="$DREDD_MANAGED_DIR/manage.log"
grep -q "sweep-skip-others-active" "$LOG" \
  && pass "manage.log records sweep-skip-others-active" \
  || fail "no skip-others entry in log: $(cat "$LOG")"

# -----------------------------------------------------------------------------
section "Hook integration — SessionEnd strips rules; UserPromptSubmit sweeps"

# Spin up stub server so the hook gets past the /health probe.
python3 - "$TMP" <<'PY' &
import http.server, sys, threading, time
out = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def do_POST(self):
        ln = int(self.headers.get("content-length","0"))
        body = self.rfile.read(ln) if ln else b""
        with open(f"{out}/last-{self.path.strip('/')}.json","wb") as f: f.write(body)
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
        self.wfile.write(b'{"_meta":{"ok":true}}')
    def log_message(self, *a, **kw): pass
srv = http.server.HTTPServer(("127.0.0.1", 17193), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
print("ready", flush=True)
time.sleep(60)
PY
STUB_PID=$!
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:17193/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

FH="$TMP/home"; mkdir -p "$FH/.claude"
export HOME="$FH"
export DREDD_URL="http://127.0.0.1:17193"
export DREDD_PERM_CACHE_DIR="$TMP/perm-cache"

PROJ_HOOK="$TMP/proj-hook"
mkdir -p "$PROJ_HOOK/.claude"
echo '{"permissions":{"allow":["Bash(my-tool:*)"]}}' > "$PROJ_HOOK/.claude/settings.local.json"

# Run UserPromptSubmit → rules injected, sidecar created.
HOOK_INPUT=$(jq -n --arg sid "hk-sess" --arg p "x" --arg c "$PROJ_HOOK" \
  '{hook_event_name:"UserPromptSubmit", session_id:$sid, prompt:$p, cwd:$c}')
echo "$HOOK_INPUT" | bash "$HOOK" >/dev/null
ALLOW=$(jq -c '.permissions.allow | sort' "$PROJ_HOOK/.claude/settings.local.json")
echo "$ALLOW" | jq -e '. | length > 1' >/dev/null \
  && pass "hook UserPromptSubmit injected managed rules" \
  || fail "no managed rules after hook run: $ALLOW"

# Run SessionEnd → managed rules stripped, user rule kept.
SE_INPUT=$(jq -n --arg sid "hk-sess" \
  '{hook_event_name:"SessionEnd", session_id:$sid}')
echo "$SE_INPUT" | bash "$HOOK" >/dev/null
ALLOW=$(jq -c '.permissions.allow' "$PROJ_HOOK/.claude/settings.local.json")
[ "$ALLOW" = '["Bash(my-tool:*)"]' ] && pass "SessionEnd left only the user's own rule" \
  || fail "expected user rule only, got $ALLOW"
HK_SP=$(dredd_sidecar_path "$PROJ_HOOK" "hk-sess")
[ ! -f "$HK_SP" ] && pass "SessionEnd deleted the sidecar" || fail "sidecar still present"

# Sweep on UserPromptSubmit: create a stale sidecar by running once and
# then backdating its lastTouched.
echo "$HOOK_INPUT" | bash "$HOOK" >/dev/null
HK_SP=$(dredd_sidecar_path "$PROJ_HOOK" "hk-sess")
backdate_sidecar "$HK_SP" "2026-05-11T00:00:00Z"

# A second session's UserPromptSubmit on a different project should
# sweep the stale one (running with a very low staleSecs override so
# the test doesn't depend on real clock skew).
PROJ_OTHER="$TMP/proj-other"
mkdir -p "$PROJ_OTHER/.claude"
HOOK_INPUT_OTHER=$(jq -n --arg sid "other-sess" --arg p "x" --arg c "$PROJ_OTHER" \
  '{hook_event_name:"UserPromptSubmit", session_id:$sid, prompt:$p, cwd:$c}')
echo "$HOOK_INPUT_OTHER" | DREDD_MANAGED_SIDECAR_STALE_SECS=1 bash "$HOOK" >/dev/null

[ ! -f "$HK_SP" ] && pass "stale sidecar swept by next UserPromptSubmit" \
  || fail "stale sidecar still present"
# proj-hook's managed rules should be gone (only the user's own rule survives).
ALLOW=$(jq -c '.permissions.allow' "$PROJ_HOOK/.claude/settings.local.json")
[ "$ALLOW" = '["Bash(my-tool:*)"]' ] && pass "sweep stripped stale session's managed rules" \
  || fail "stale rules still in proj-hook: $ALLOW"

kill "$STUB_PID" 2>/dev/null
STUB_PID=""

# -----------------------------------------------------------------------------
printf "\n  %d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
