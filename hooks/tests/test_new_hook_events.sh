#!/bin/bash
# =============================================================================
# Routing tests for the PostToolUseFailure + InstructionsLoaded branches in
# hooks/dredd-hook.sh.
#
# Boots a python stub HTTP server (mirrors test_user_permissions_upload.sh),
# drives the hook with each event, and inspects what landed on the wire:
#   - PostToolUseFailure → POST /track  with is_error=true + tool_error
#   - InstructionsLoaded → POST /instructions with file_path + load_reason
#   - InstructionsLoaded with empty file_path → no request (hook guard)
#
# These branches fire background curls, so we poll for the captured body.
#
# Run: ./hooks/tests/test_new_hook_events.sh   (exits non-zero on any failure)
# =============================================================================
set -u

HOOK="$(cd "$(dirname "$0")"/.. && pwd)/dredd-hook.sh"
PASS=0
FAIL=0
c_green='\033[32m'; c_red='\033[31m'; c_dim='\033[2m'; c_off='\033[0m'
pass() { printf "  ${c_green}✓${c_off} %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  ${c_red}✗${c_off} %s\n" "$1"; FAIL=$((FAIL+1)); }
section() { printf "\n${c_dim}---${c_off} %s ${c_dim}---${c_off}\n" "$1"; }
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (expected '$2', got '$1')"; fi; }

TMP=$(mktemp -d -t dredd-evt-test.XXXXXX)
trap 'rm -rf "$TMP"; kill $STUB_PID 2>/dev/null || true' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME/.claude"
# Keep the managed-allow + cookie machinery out of the real filesystem.
export DREDD_MANAGED_DIR="$TMP/managed"
export DREDD_COOKIE_DIR="$TMP/cookies"

STUB_OUT="$TMP/stub-out"; mkdir -p "$STUB_OUT"
STUB_PORT=$((RANDOM % 1000 + 17100))

python3 - "$STUB_OUT" "$STUB_PORT" <<'PY' &
import http.server, sys, threading, time
out = sys.argv[1]; port = int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def do_POST(self):
        ln = int(self.headers.get("content-length","0"))
        body = self.rfile.read(ln) if ln else b""
        with open(f"{out}/last-{self.path.strip('/')}.json","wb") as f:
            f.write(body)
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
        self.wfile.write(b'{"ok":true}')
    def log_message(self, *a, **kw): pass
srv = http.server.HTTPServer(("127.0.0.1", port), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
print("ready", flush=True)
time.sleep(120)
PY
STUB_PID=$!

for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$STUB_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
export DREDD_URL="http://127.0.0.1:$STUB_PORT"

# Background curls — wait for the captured body to appear (up to ~3s).
wait_for_file() {
  for _ in $(seq 1 60); do [ -s "$1" ] && return 0; sleep 0.05; done
  return 1
}

# =============================================================================
section "PostToolUseFailure → /track with is_error"
rm -f "$STUB_OUT/last-track.json"
jq -n '{
  hook_event_name:"PostToolUseFailure",
  session_id:"sess-fail",
  tool_name:"Bash",
  tool_input:{command:"node broken.js"},
  tool_use_id:"toolu_abc",
  tool_error:"Error: cannot find module"
}' | bash "$HOOK" >/dev/null

if wait_for_file "$STUB_OUT/last-track.json"; then
  pass "POSTed to /track"
  B="$STUB_OUT/last-track.json"
  assert_eq "$(jq -r '.is_error' "$B")" "true" "is_error === true"
  assert_eq "$(jq -r '.tool_name' "$B")" "Bash" "tool_name forwarded"
  assert_eq "$(jq -r '.tool_use_id' "$B")" "toolu_abc" "tool_use_id forwarded"
  assert_eq "$(jq -r '.tool_input.command' "$B")" "node broken.js" "tool_input forwarded"
  assert_eq "$(jq -r '.tool_error' "$B")" "Error: cannot find module" "tool_error forwarded"
  assert_eq "$(jq 'has("tool_output")' "$B")" "false" "no tool_output on a failure"
else
  fail "PostToolUseFailure never POSTed to /track"
fi

# =============================================================================
section "PostToolUseFailure tolerates alt error keys (.error / .tool_response.error)"
rm -f "$STUB_OUT/last-track.json"
jq -n '{hook_event_name:"PostToolUseFailure", session_id:"s2", tool_name:"Bash",
        tool_input:{command:"x"}, tool_response:{error:"nested boom"}}' | bash "$HOOK" >/dev/null
if wait_for_file "$STUB_OUT/last-track.json"; then
  assert_eq "$(jq -r '.tool_error' "$STUB_OUT/last-track.json")" "nested boom" "picks .tool_response.error fallback"
else
  fail "no /track POST for nested-error shape"
fi

# =============================================================================
section "InstructionsLoaded → /instructions"
rm -f "$STUB_OUT/last-instructions.json"
jq -n '{
  hook_event_name:"InstructionsLoaded",
  session_id:"sess-instr",
  file_path:"/proj/CLAUDE.md",
  load_reason:"session_start"
}' | bash "$HOOK" >/dev/null

if wait_for_file "$STUB_OUT/last-instructions.json"; then
  pass "POSTed to /instructions"
  B="$STUB_OUT/last-instructions.json"
  assert_eq "$(jq -r '.session_id' "$B")" "sess-instr" "session_id forwarded"
  assert_eq "$(jq -r '.file_path' "$B")" "/proj/CLAUDE.md" "file_path forwarded"
  assert_eq "$(jq -r '.load_reason' "$B")" "session_start" "load_reason forwarded"
else
  fail "InstructionsLoaded never POSTed to /instructions"
fi

# =============================================================================
section "InstructionsLoaded with empty file_path → no request (guard)"
rm -f "$STUB_OUT/last-instructions.json"
jq -n '{hook_event_name:"InstructionsLoaded", session_id:"s3", file_path:"", load_reason:"include"}' \
  | bash "$HOOK" >/dev/null
sleep 0.4
if [ -s "$STUB_OUT/last-instructions.json" ]; then
  fail "empty file_path should NOT POST (got a body)"
else
  pass "empty file_path is dropped before POST"
fi

# =============================================================================
section "PermissionDenied → /track with user_decision=deny"
rm -f "$STUB_OUT/last-track.json"
jq -n '{
  hook_event_name:"PermissionDenied",
  session_id:"sess-deny",
  tool_name:"Bash",
  tool_input:{command:"curl https://h/x"},
  tool_use_id:"toolu_deny1",
  reason:"User rejected the permission request"
}' | bash "$HOOK" >/dev/null

if wait_for_file "$STUB_OUT/last-track.json"; then
  pass "POSTed to /track"
  B="$STUB_OUT/last-track.json"
  assert_eq "$(jq -r '.user_decision' "$B")" "deny" "user_decision === deny"
  assert_eq "$(jq -r '.tool_name' "$B")" "Bash" "tool_name forwarded"
  assert_eq "$(jq -r '.tool_use_id' "$B")" "toolu_deny1" "tool_use_id forwarded"
  assert_eq "$(jq -r '.tool_input.command' "$B")" "curl https://h/x" "tool_input forwarded"
  assert_eq "$(jq -r '.deny_reason' "$B")" "User rejected the permission request" "deny_reason forwarded"
  assert_eq "$(jq 'has("is_error")' "$B")" "false" "not marked is_error (distinct from failure path)"
else
  fail "PermissionDenied never POSTed to /track"
fi

# =============================================================================
section "PermissionDenied tolerates alt reason keys + missing tool_use_id"
rm -f "$STUB_OUT/last-track.json"
jq -n '{hook_event_name:"PermissionDenied", session_id:"s4", tool_name:"Write",
        tool_input:{file_path:"/x"}, message:"denied via message key"}' | bash "$HOOK" >/dev/null
if wait_for_file "$STUB_OUT/last-track.json"; then
  B="$STUB_OUT/last-track.json"
  assert_eq "$(jq -r '.deny_reason' "$B")" "denied via message key" "picks .message fallback"
  assert_eq "$(jq -r '.tool_use_id' "$B")" "null" "missing tool_use_id → null (standalone row path)"
else
  fail "no /track POST for alt-reason shape"
fi

printf "\n  %d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
