#!/bin/bash
# =============================================================================
# Tests for the Phase 7b reconciliation function
# (dredd_reconcile_managed_allow) AND for the integration in
# hooks/dredd-hook.sh's UserPromptSubmit branch.
#
# Run: ./hooks/tests/test_phase7b_reconcile.sh
# Exits non-zero on any failure.
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

TMP=$(mktemp -d -t dredd-phase7b.XXXXXX)
STUB_PID=""
trap '[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

export DREDD_MANAGED_DIR="$TMP/managed"
mkdir -p "$DREDD_MANAGED_DIR"

# shellcheck disable=SC1090
. "$SUT_PRIMS"

# -----------------------------------------------------------------------------
section "dredd_reconcile_managed_allow — pure-primitive tests"

PROJ="$TMP/proj-A"
mkdir -p "$PROJ/.claude"
SID="sess-A"
SLP="$PROJ/.claude/settings.local.json"

# First reconcile: empty prior, conservative desired.
DESIRED='["Read","Bash(awk:*)"]'
dredd_reconcile_managed_allow "$PROJ" "$SID" "conservative" "$DESIRED" \
  && pass "first reconcile succeeded" || fail "reconcile returned non-zero"

[ -f "$SLP" ] && pass "settings.local.json was created" || fail "settings.local.json missing"
ALLOW=$(jq -c '.permissions.allow | sort' "$SLP")
[ "$ALLOW" = '["Bash(awk:*)","Read"]' ] && pass "rules present after first reconcile" \
  || fail "expected sorted Read+awk, got $ALLOW"

SIDECAR=$(dredd_sidecar_path "$PROJ" "$SID")
dredd_sidecar_read "$SIDECAR"
[ "$(echo "$SIDECAR_RULES" | jq -c 'sort')" = '["Bash(awk:*)","Read"]' ] \
  && pass "sidecar.rulesManaged matches desired" \
  || fail "sidecar rules wrong: $SIDECAR_RULES"
[ "$SIDECAR_SCOPE" = "conservative" ] && pass "sidecar.scope persisted" \
  || fail "sidecar scope: $SIDECAR_SCOPE"

# Second reconcile with same desired → no-op (settings unchanged,
# sidecar lastTouched bumped).
FIRST_TOUCHED="$SIDECAR_TOUCHED"
FIRST_ALLOW="$ALLOW"
sleep 1
dredd_reconcile_managed_allow "$PROJ" "$SID" "conservative" "$DESIRED"
ALLOW_AFTER=$(jq -c '.permissions.allow | sort' "$SLP")
[ "$ALLOW_AFTER" = "$FIRST_ALLOW" ] && pass "idempotent: rules unchanged on re-run" \
  || fail "rules changed: $FIRST_ALLOW → $ALLOW_AFTER"
dredd_sidecar_read "$SIDECAR"
[ "$SIDECAR_TOUCHED" != "$FIRST_TOUCHED" ] && pass "sidecar.lastTouched advances" \
  || fail "lastTouched stuck: $SIDECAR_TOUCHED"

# Shrink desired (Read drops out) → reconcile must remove Read but
# keep Bash(awk:*) and the sidecar's rulesManaged shrinks too.
dredd_reconcile_managed_allow "$PROJ" "$SID" "conservative" '["Bash(awk:*)"]'
ALLOW=$(jq -c '.permissions.allow | sort' "$SLP")
[ "$ALLOW" = '["Bash(awk:*)"]' ] && pass "scope shrink removed Read" \
  || fail "expected just awk, got $ALLOW"
dredd_sidecar_read "$SIDECAR"
[ "$(echo "$SIDECAR_RULES" | jq -c .)" = '["Bash(awk:*)"]' ] \
  && pass "sidecar reflects shrunk desired set" \
  || fail "sidecar: $SIDECAR_RULES"

# Scope = off → all managed rules removed.
dredd_reconcile_managed_allow "$PROJ" "$SID" "off" '[]'
ALLOW=$(jq -c '.permissions.allow' "$SLP")
[ "$ALLOW" = "[]" ] && pass "off scope cleared all Dredd-managed entries" \
  || fail "expected [], got $ALLOW"

# User rules should survive every reconciliation step.
cat > "$SLP" <<'EOF'
{
  "permissions": {
    "allow": ["Bash(npm:*)", "WebFetch(domain:github.com)"]
  }
}
EOF
dredd_reconcile_managed_allow "$PROJ" "$SID" "conservative" '["Read","Bash(awk:*)"]'
ALLOW=$(jq -c '.permissions.allow | sort' "$SLP")
echo "$ALLOW" | jq -e '. | contains(["Bash(npm:*)","WebFetch(domain:github.com)","Read","Bash(awk:*)"])' >/dev/null \
  && pass "user rules survive alongside Dredd-added rules" \
  || fail "user rules lost: $ALLOW"

# Subsequent shrink — user rules still safe.
dredd_reconcile_managed_allow "$PROJ" "$SID" "off" '[]'
ALLOW=$(jq -c '.permissions.allow | sort' "$SLP")
echo "$ALLOW" | jq -e '. | contains(["Bash(npm:*)","WebFetch(domain:github.com)"])' >/dev/null \
  && pass "user rules survive after off-scope cleanup" \
  || fail "user rules lost: $ALLOW"
echo "$ALLOW" | jq -e '. | contains(["Read","Bash(awk:*)"])' >/dev/null \
  && fail "Dredd-managed rules should be gone but found in $ALLOW" \
  || pass "Dredd-managed rules cleared, user rules intact"

# Audit log written.
LOG="$DREDD_MANAGED_DIR/manage.log"
[ -s "$LOG" ] && pass "manage.log accumulates entries" || fail "manage.log empty"
ENTRIES=$(wc -l < "$LOG" | tr -d ' ')
[ "$ENTRIES" -ge 4 ] && pass "manage.log has ≥4 entries across the test run" \
  || fail "expected ≥4 audit lines, got $ENTRIES"

# -----------------------------------------------------------------------------
section "Hook integration — UserPromptSubmit triggers reconciliation"

# Spin up a stub server (reuses the Phase 1 test fixture).
python3 - "$TMP" <<'PY' &
import http.server, sys, threading, time
out = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def do_POST(self):
        ln = int(self.headers.get("content-length","0"))
        body = self.rfile.read(ln) if ln else b""
        with open(f"{out}/last-{self.path.strip('/')}.json","wb") as f:
            f.write(body)
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
        self.wfile.write(b'{"_meta":{"ok":true}}')
    def log_message(self, *a, **kw): pass
srv = http.server.HTTPServer(("127.0.0.1", 17181), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
print("ready", flush=True)
time.sleep(120)
PY
STUB_PID=$!
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:17181/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

# Fresh project + isolated $HOME so the hook's other helpers don't
# read the developer's real settings.
FAKE_HOME="$TMP/home"
mkdir -p "$FAKE_HOME/.claude"
export HOME="$FAKE_HOME"
export DREDD_URL="http://127.0.0.1:17181"
export DREDD_PERM_CACHE_DIR="$TMP/perm-cache"

PROJ_HOOK="$TMP/proj-hook"
mkdir -p "$PROJ_HOOK/.claude"
HOOK_INPUT=$(jq -n --arg sid "hook-sess-1" --arg p "hello" --arg c "$PROJ_HOOK" \
  '{hook_event_name:"UserPromptSubmit",session_id:$sid,prompt:$p,cwd:$c}')

# Conservative scope (default).
unset DREDD_MANAGED_ALLOW_SCOPE
unset DREDD_MANAGED_ALLOW_RULES
echo "$HOOK_INPUT" | bash "$HOOK" >/dev/null
SLP_HOOK="$PROJ_HOOK/.claude/settings.local.json"
[ -f "$SLP_HOOK" ] && pass "hook created settings.local.json on first UserPromptSubmit" \
  || fail "no settings.local.json after hook run"
ALLOW=$(jq -c '.permissions.allow | sort' "$SLP_HOOK")
echo "$ALLOW" | jq -e '. | index("Read") != null' >/dev/null \
  && pass "Read present in managed rules" || fail "Read missing: $ALLOW"
echo "$ALLOW" | jq -e '. | index("Bash(awk:*)") != null' >/dev/null \
  && pass "Bash(awk:*) present" || fail "Bash(awk:*) missing: $ALLOW"

# Sidecar created with the conservative rule set.
SIDECAR_HOOK=$(dredd_sidecar_path "$PROJ_HOOK" "hook-sess-1")
[ -f "$SIDECAR_HOOK" ] && pass "sidecar created for hook session" \
  || fail "no sidecar at $SIDECAR_HOOK"

# Run again with scope=off — managed rules cleared.
DREDD_MANAGED_ALLOW_SCOPE="off" \
  bash -c "echo '$HOOK_INPUT' | bash \"$HOOK\"" >/dev/null
ALLOW=$(jq -c '.permissions.allow' "$SLP_HOOK")
[ "$ALLOW" = "[]" ] && pass "scope=off via env var cleared rules" \
  || fail "expected [], got $ALLOW"

# Operator override: custom JSON list wins over scope defaults.
DREDD_MANAGED_ALLOW_RULES='["Bash(jq:*)"]' \
  bash -c "echo '$HOOK_INPUT' | bash \"$HOOK\"" >/dev/null
ALLOW=$(jq -c '.permissions.allow' "$SLP_HOOK")
[ "$ALLOW" = '["Bash(jq:*)"]' ] && pass "DREDD_MANAGED_ALLOW_RULES override applied" \
  || fail "expected ['Bash(jq:*)'], got $ALLOW"

kill "$STUB_PID" 2>/dev/null
STUB_PID=""

# -----------------------------------------------------------------------------
printf "\n  %d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
