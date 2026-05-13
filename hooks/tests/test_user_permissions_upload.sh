#!/bin/bash
# =============================================================================
# Tests for the user-permissions upload helpers in hooks/dredd-hook.sh.
#
# Covers:
#   - build_user_permissions_payload (merge / dedupe / sort / empty cases)
#   - sha256_string (length, determinism)
#   - read_perm_cache / write_perm_cache (round-trip + defaults)
#   - Full hook E2E against a python stub server:
#       * first run sends full payload + writes cache
#       * unchanged-hash run sends hash-only + bumps counter
#       * hash change re-uploads full + resets counter
#       * counter >= 50 forces full upload (heartbeat)
#       * lastFullUploadAt > 24h ago forces full upload (heartbeat)
#       * server replying with user_permissions_resync: true clears cache
#
# Run: ./hooks/tests/test_user_permissions_upload.sh
# Exits non-zero on any failure.
# =============================================================================
set -u

HOOK="$(cd "$(dirname "$0")"/.. && pwd)/dredd-hook.sh"
PASS=0
FAIL=0

c_green='\033[32m'
c_red='\033[31m'
c_dim='\033[2m'
c_off='\033[0m'

pass() { printf "  ${c_green}✓${c_off} %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  ${c_red}✗${c_off} %s\n" "$1"; FAIL=$((FAIL+1)); }
note() { printf "  ${c_dim}%s${c_off}\n" "$1"; }
section() { printf "\n${c_dim}---${c_off} %s ${c_dim}---${c_off}\n" "$1"; }

assert_eq() {
  if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (expected '$2', got '$1')"; fi
}
assert_empty() {
  if [ -z "$1" ]; then pass "$2"; else fail "$2 (got non-empty: $1)"; fi
}
assert_nonempty() {
  if [ -n "$1" ]; then pass "$2"; else fail "$2 (was empty)"; fi
}

# -----------------------------------------------------------------------------
# Extract just the helper block from the hook script so we can source it
# without triggering the main case statement.
# -----------------------------------------------------------------------------
extract_helpers() {
  awk '
    /^DREDD_PERM_CACHE_DIR=/ { capture=1 }
    /^# Helper: read CLAUDE\.md/ { capture=0 }
    capture { print }
  ' "$HOOK"
}

# -----------------------------------------------------------------------------
# Setup an isolated environment (fake $HOME, fake $DREDD_PERM_CACHE_DIR).
# -----------------------------------------------------------------------------
TMP=$(mktemp -d -t dredd-perm-test.XXXXXX)
trap 'rm -rf "$TMP"; kill $STUB_PID 2>/dev/null || true' EXIT

FAKE_HOME="$TMP/home"
mkdir -p "$FAKE_HOME/.claude"
export HOME="$FAKE_HOME"
export DREDD_PERM_CACHE_DIR="$TMP/cache"
mkdir -p "$DREDD_PERM_CACHE_DIR"

# Load helpers into the current shell.
eval "$(extract_helpers)"

# =============================================================================
# build_user_permissions_payload
# =============================================================================
section "build_user_permissions_payload"

# All 3 layers populated → sorted+deduped union with all entries present.
PROJ1="$TMP/proj1"; mkdir -p "$PROJ1/.claude"
cat > "$FAKE_HOME/.claude/settings.json" <<'EOF'
{ "permissions": { "allow": ["Bash(ls:*)", "Read"], "deny": ["Bash(curl:*)"] } }
EOF
cat > "$PROJ1/.claude/settings.json" <<'EOF'
{ "permissions": { "allow": ["Bash(npm:*)", "Read"], "ask": ["Bash(rm:*)"] } }
EOF
cat > "$PROJ1/.claude/settings.local.json" <<'EOF'
{ "permissions": { "allow": ["Bash(awk:*)"], "deny": ["Bash(sudo:*)"] } }
EOF
P=$(build_user_permissions_payload "$PROJ1")
assert_nonempty "$P" "merges layers when all 3 are present"
ALLOW_HAS_AWK=$(echo "$P" | jq '.allow | any(. == "Bash(awk:*)")')
assert_eq "$ALLOW_HAS_AWK" "true" "merged .allow contains local-layer entry"
ALLOW_HAS_NPM=$(echo "$P" | jq '.allow | any(. == "Bash(npm:*)")')
assert_eq "$ALLOW_HAS_NPM" "true" "merged .allow contains project-layer entry"
ALLOW_HAS_LS=$(echo "$P" | jq '.allow | any(. == "Bash(ls:*)")')
assert_eq "$ALLOW_HAS_LS" "true" "merged .allow contains user-layer entry"
READ_COUNT=$(echo "$P" | jq '[.allow[] | select(. == "Read")] | length')
assert_eq "$READ_COUNT" "1" "duplicate 'Read' entry deduplicated"

# Sorted output for stable hashing.
SORTED=$(echo "$P" | jq -c '.allow == (.allow | sort)')
assert_eq "$SORTED" "true" ".allow is sorted"

# Empty case: no settings files anywhere.
rm -f "$FAKE_HOME/.claude/settings.json"
EMPTY_PROJ="$TMP/empty-proj"; mkdir -p "$EMPTY_PROJ"
P=$(build_user_permissions_payload "$EMPTY_PROJ")
assert_empty "$P" "no settings files → empty payload"

# All-empty arrays case.
mkdir -p "$EMPTY_PROJ/.claude"
echo '{"permissions": {"allow":[], "deny":[], "ask":[]}}' > "$EMPTY_PROJ/.claude/settings.json"
P=$(build_user_permissions_payload "$EMPTY_PROJ")
assert_empty "$P" "all-empty arrays → empty payload (no point uploading nothing)"

# Missing .permissions key.
echo '{"someOtherKey":"value"}' > "$EMPTY_PROJ/.claude/settings.json"
P=$(build_user_permissions_payload "$EMPTY_PROJ")
assert_empty "$P" "missing .permissions key → empty payload"

# Malformed JSON: fail-safe (jq error swallowed, returns empty).
echo '{ this is not json }' > "$EMPTY_PROJ/.claude/settings.json"
P=$(build_user_permissions_payload "$EMPTY_PROJ")
assert_empty "$P" "malformed JSON → empty payload (fail-safe)"

# Single-layer with rules → upload triggered.
echo '{"permissions": {"deny":["Bash(rm:-rf:*)"]}}' > "$EMPTY_PROJ/.claude/settings.json"
P=$(build_user_permissions_payload "$EMPTY_PROJ")
HAS_RM=$(echo "$P" | jq '.deny | any(. == "Bash(rm:-rf:*)")')
assert_eq "$HAS_RM" "true" "single-layer rule triggers payload"

# =============================================================================
# sha256_string
# =============================================================================
section "sha256_string"

H1=$(sha256_string "hello")
assert_eq "${#H1}" "64" "hash is 64 hex chars"
H2=$(sha256_string "hello")
assert_eq "$H1" "$H2" "deterministic across calls"

# Order independence is delegated to build_user_permissions_payload's
# sort step — verify here using two equivalent inputs.
A=$(mktemp -d -t dredd-h-a.XXXXXX); mkdir -p "$A/.claude"
B=$(mktemp -d -t dredd-h-b.XXXXXX); mkdir -p "$B/.claude"
echo '{"permissions":{"allow":["X","A","M"]}}' > "$A/.claude/settings.json"
echo '{"permissions":{"allow":["M","A","X"]}}' > "$B/.claude/settings.json"
HA=$(sha256_string "$(build_user_permissions_payload "$A")")
HB=$(sha256_string "$(build_user_permissions_payload "$B")")
assert_eq "$HA" "$HB" "hash is order-independent (sort applied before hashing)"
rm -rf "$A" "$B"

# =============================================================================
# read_perm_cache / write_perm_cache
# =============================================================================
section "perm cache round-trip"

PROJ_ROUND="$TMP/round"
mkdir -p "$PROJ_ROUND/.claude"
echo '{"permissions":{"allow":["X"]}}' > "$PROJ_ROUND/.claude/settings.json"
CACHE_FILE=$(perm_cache_path "$PROJ_ROUND")
write_perm_cache "$CACHE_FILE" "deadbeef" 7 1700000000
read_perm_cache "$CACHE_FILE"
assert_eq "$CACHED_HASH" "deadbeef" "hash round-trips"
assert_eq "$CACHED_COUNTER" "7" "counter round-trips"
assert_eq "$CACHED_LAST_FULL_AT" "1700000000" "lastFullUploadAt round-trips"

read_perm_cache "$TMP/does-not-exist.json"
assert_eq "$CACHED_HASH" "" "missing cache → empty hash"
assert_eq "$CACHED_COUNTER" "0" "missing cache → counter 0"
assert_eq "$CACHED_LAST_FULL_AT" "0" "missing cache → lastFullUploadAt 0"

# =============================================================================
# Full hook E2E — boot a python stub HTTP server, drive the hook, inspect
# what landed on the wire.
# =============================================================================
section "hook E2E (stub server)"

STUB_OUT="$TMP/stub-out"
mkdir -p "$STUB_OUT"
STUB_PORT=$((RANDOM % 1000 + 17100))

python3 - "$STUB_OUT" "$STUB_PORT" <<'PY' &
import http.server, sys, threading, time
out = sys.argv[1]; port = int(sys.argv[2])
state = {"resync": False}

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/__resync_on":
            state["resync"] = True
        elif self.path == "/__resync_off":
            state["resync"] = False
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def do_POST(self):
        ln = int(self.headers.get("content-length","0"))
        body = self.rfile.read(ln) if ln else b""
        with open(f"{out}/last-{self.path.strip('/')}.json","wb") as f:
            f.write(body)
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
        if state["resync"]:
            self.wfile.write(b'{"user_permissions_resync": true}')
        else:
            self.wfile.write(b'{"_meta":{"ok":true}}')
    def log_message(self, *a, **kw): pass

srv = http.server.HTTPServer(("127.0.0.1", port), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
print("ready", flush=True)
time.sleep(120)
PY
STUB_PID=$!

# Wait for /health to respond (race: python sleeps to bind).
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$STUB_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

export DREDD_URL="http://127.0.0.1:$STUB_PORT"

# Fresh cache dir + project for E2E so we don't see cache files left
# over from the round-trip section above.
rm -rf "$DREDD_PERM_CACHE_DIR" && mkdir -p "$DREDD_PERM_CACHE_DIR"
PROJ_E2E="$TMP/proj-e2e"; mkdir -p "$PROJ_E2E/.claude"
echo '{"permissions":{"allow":["Bash(awk:*)","Read"]}}' > "$FAKE_HOME/.claude/settings.json"
echo '{"permissions":{"deny":["Bash(curl:*)"]}}' > "$PROJ_E2E/.claude/settings.local.json"

HOOK_INPUT=$(jq -n --arg sid "s" --arg p "x" --arg c "$PROJ_E2E" \
  '{hook_event_name:"UserPromptSubmit", session_id:$sid, prompt:$p, cwd:$c}')

run_hook() { echo "$HOOK_INPUT" | bash "$HOOK" >/dev/null; }
# Look the cache file up by the same path the hook uses, not by ls —
# avoids picking up stale files written by earlier sections.
e2e_cache_file() { perm_cache_path "$PROJ_E2E"; }

# --- First run: full payload + cache initialised ---
run_hook
HAS_HASH=$(jq 'has("user_permissions_hash")' "$STUB_OUT/last-intent.json")
HAS_PAYLOAD=$(jq 'has("user_permissions")' "$STUB_OUT/last-intent.json")
assert_eq "$HAS_HASH" "true" "first run: user_permissions_hash on wire"
assert_eq "$HAS_PAYLOAD" "true" "first run: full user_permissions on wire"
CF=$(e2e_cache_file)
assert_nonempty "$CF" "first run: cache file written"
COUNTER=$(jq '.promptsSinceFullUpload' "$CF")
assert_eq "$COUNTER" "0" "first run: counter initialised to 0"

# --- Second run: unchanged settings → hash-only ---
run_hook
HAS_PAYLOAD=$(jq 'has("user_permissions")' "$STUB_OUT/last-intent.json")
HAS_HASH=$(jq 'has("user_permissions_hash")' "$STUB_OUT/last-intent.json")
assert_eq "$HAS_HASH" "true" "second run: hash still on wire"
assert_eq "$HAS_PAYLOAD" "false" "second run: full payload OMITTED"
COUNTER=$(jq '.promptsSinceFullUpload' "$CF")
assert_eq "$COUNTER" "1" "second run: counter bumped to 1"

# --- Settings change → full re-upload, counter reset ---
echo '{"permissions":{"allow":["Bash(awk:*)","Read","Bash(sed:*)"]}}' > "$FAKE_HOME/.claude/settings.json"
run_hook
HAS_PAYLOAD=$(jq 'has("user_permissions")' "$STUB_OUT/last-intent.json")
assert_eq "$HAS_PAYLOAD" "true" "hash change: full payload re-sent"
COUNTER=$(jq '.promptsSinceFullUpload' "$CF")
assert_eq "$COUNTER" "0" "hash change: counter reset to 0"

# --- Count-based heartbeat: counter ≥ 50 → forced full upload ---
# Heartbeat condition reads the cache from BEFORE this prompt, so the
# cache must already hold counter == DREDD_PERM_FULL_REUPLOAD_EVERY_N
# (= 50) to trip it on this call.
jq '.promptsSinceFullUpload = 50 | .lastFullUploadAt = 9999999999' "$CF" > "$CF.tmp" && mv "$CF.tmp" "$CF"
run_hook
HAS_PAYLOAD=$(jq 'has("user_permissions")' "$STUB_OUT/last-intent.json")
assert_eq "$HAS_PAYLOAD" "true" "counter≥50: heartbeat forces full upload"
COUNTER=$(jq '.promptsSinceFullUpload' "$CF")
assert_eq "$COUNTER" "0" "counter≥50: counter reset after heartbeat"

# --- Time-based heartbeat: lastFullUploadAt > 24h ago ---
NOW=$(date +%s); OLD=$((NOW - 90000))   # 25h ago
jq --argjson old "$OLD" '.promptsSinceFullUpload = 2 | .lastFullUploadAt = $old' "$CF" > "$CF.tmp" && mv "$CF.tmp" "$CF"
run_hook
HAS_PAYLOAD=$(jq 'has("user_permissions")' "$STUB_OUT/last-intent.json")
assert_eq "$HAS_PAYLOAD" "true" "24h+ stale: heartbeat forces full upload"

# --- Resync flag clears cache → next run forced full ---
curl -sf "http://127.0.0.1:$STUB_PORT/__resync_on" >/dev/null
run_hook
[ -f "$CF" ] && fail "resync flag should have removed cache file" || pass "resync flag removed cache file"

curl -sf "http://127.0.0.1:$STUB_PORT/__resync_off" >/dev/null
run_hook
HAS_PAYLOAD=$(jq 'has("user_permissions")' "$STUB_OUT/last-intent.json")
assert_eq "$HAS_PAYLOAD" "true" "after resync: next run re-sends full payload"

# =============================================================================
section "summary"
printf "  %d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
