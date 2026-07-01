#!/bin/bash
# =============================================================================
# Regression: build_transcript_summary must bound its work to a recent TAIL of
# the transcript. On very long sessions (100MB+, 1000s of turns) the old code
# slurped the whole file with `jq -s` (seconds) AND shipped every historical
# prompt to /intent, blowing the UserPromptSubmit hook's 30s budget.
#
# Boots a python stub (mirrors test_new_hook_events.sh), drives the hook with a
# UserPromptSubmit event, and inspects the .transcript_summary it POSTs:
#   A. the goal anchor (lastUserText) is still the most recent non-confirmation
#      prompt, and prompts beyond DREDD_TRANSCRIPT_SUMMARY_MAX_LINES are dropped
#   B. userPrompts is capped (<=60) regardless of density
#
# Run: ./hooks/tests/test_transcript_summary_bounded.sh  (non-zero on failure)
# =============================================================================
set -u

HOOK="$(cd "$(dirname "$0")"/.. && pwd)/dredd-hook.sh"
PASS=0; FAIL=0
c_green='\033[32m'; c_red='\033[31m'; c_dim='\033[2m'; c_off='\033[0m'
pass()   { printf "  ${c_green}\xe2\x9c\x93${c_off} %s\n" "$1"; PASS=$((PASS+1)); }
fail()   { printf "  ${c_red}\xe2\x9c\x97${c_off} %s\n" "$1"; FAIL=$((FAIL+1)); }
section(){ printf "\n${c_dim}---${c_off} %s ${c_dim}---${c_off}\n" "$1"; }
assert_eq(){ if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (want '$2' got '$1')"; fi; }

TMP=$(mktemp -d -t dredd-tsum.XXXXXX)
trap 'rm -rf "$TMP"; kill $STUB_PID 2>/dev/null || true' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME/.claude"
export DREDD_MANAGED_DIR="$TMP/managed"
export DREDD_COOKIE_DIR="$TMP/cookies"
export DREDD_MANAGED_ALLOW_SCOPE=off   # keep managed-allow out of the way

STUB_OUT="$TMP/stub"; mkdir -p "$STUB_OUT"
STUB_PORT=$((RANDOM % 1000 + 17200))
python3 - "$STUB_OUT" "$STUB_PORT" <<'PY' &
import http.server, sys, threading, time
out=sys.argv[1]; port=int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def do_POST(self):
        ln=int(self.headers.get("content-length","0")); body=self.rfile.read(ln) if ln else b""
        open(f"{out}/last-{self.path.strip('/')}.json","wb").write(body)
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self,*a,**k): pass
srv=http.server.HTTPServer(("127.0.0.1",port),H)
threading.Thread(target=srv.serve_forever,daemon=True).start()
print("ready",flush=True); time.sleep(120)
PY
STUB_PID=$!
export DREDD_URL="http://127.0.0.1:$STUB_PORT"
for _ in $(seq 1 50); do curl -sf "$DREDD_URL/health" >/dev/null 2>&1 && break; sleep 0.1; done

BODY="$STUB_OUT/last-intent.json"
drive() {  # $1 = transcript path, $2 = prompt
  rm -f "$BODY"
  jq -n --arg tp "$1" --arg p "$2" \
    '{hook_event_name:"UserPromptSubmit", session_id:"tsum1", prompt:$p, transcript_path:$tp, cwd:"/tmp/proj"}' \
    | bash "$HOOK" >/dev/null 2>&1
  for _ in $(seq 1 50); do [ -s "$BODY" ] && break; sleep 0.1; done
}

# ---- Test A: tail bound drops ancient prompts ----
section "tail bound (DREDD_TRANSCRIPT_SUMMARY_MAX_LINES=25)"
TA="$TMP/ta.jsonl"
jq -cn '{type:"user",message:{content:"ANCIENT_GOAL_XYZ do the old thing"}}' > "$TA"
for i in $(seq 1 50); do
  jq -cn --arg i "$i" '{type:"assistant",message:{content:[{type:"text",text:("padding turn " + $i)}]}}' >> "$TA"
done
jq -cn '{type:"user",message:{content:"intermediate step alpha beta gamma delta"}}' >> "$TA"
jq -cn '{type:"assistant",message:{content:[{type:"text",text:"working on it"}]}}' >> "$TA"
jq -cn '{type:"user",message:{content:"RECENT_GOAL_ABC do the new thing now please"}}' >> "$TA"

DREDD_TRANSCRIPT_SUMMARY_MAX_LINES=25 drive "$TA" "RECENT_GOAL_ABC do the new thing now please"
if [ -s "$BODY" ]; then
  assert_eq "$(jq -r '.transcript_summary.lastUserText // ""' "$BODY")" \
            "RECENT_GOAL_ABC do the new thing now please" \
            "goal anchor = most recent non-confirmation prompt"
  assert_eq "$(jq '[.transcript_summary.userPrompts[].text] | any(test("ANCIENT_GOAL_XYZ"))' "$BODY")" \
            "false" "ancient prompt beyond the tail is dropped"
  UP=$(jq '.transcript_summary.userPrompts | length' "$BODY")
  if [ "${UP:-0}" -ge 1 ]; then pass "recent prompts retained (userPrompts=$UP)"; else fail "no recent prompts (userPrompts=$UP)"; fi
else
  fail "no /intent body captured (Test A)"
fi

# ---- Test B: userPrompts capped at 60 ----
section "userPrompts cap (80 recent prompts, high max_lines)"
TB="$TMP/tb.jsonl"; : > "$TB"
for i in $(seq 1 80); do
  jq -cn --arg i "$i" '{type:"user",message:{content:("task number " + $i + " do something distinct here")}}' >> "$TB"
  jq -cn --arg i "$i" '{type:"assistant",message:{content:[{type:"text",text:("done " + $i)}]}}' >> "$TB"
done
DREDD_TRANSCRIPT_SUMMARY_MAX_LINES=5000 drive "$TB" "task number 80 do something distinct here"
if [ -s "$BODY" ]; then
  UPB=$(jq '.transcript_summary.userPrompts | length' "$BODY")
  if [ "${UPB:-0}" -le 60 ]; then pass "userPrompts capped <=60 (got $UPB)"; else fail "userPrompts NOT capped (got $UPB)"; fi
  assert_eq "$(jq -r '.transcript_summary.lastUserText // ""' "$BODY")" \
            "task number 80 do something distinct here" "goal = last prompt even when capped"
  assert_eq "$(jq '[.transcript_summary.userPrompts[].text] | any(test("^task number 1 "))' "$BODY")" \
            "false" "oldest prompt dropped by the 60-cap"
else
  fail "no /intent body captured (Test B)"
fi

printf "\n%s passed, %s failed\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
