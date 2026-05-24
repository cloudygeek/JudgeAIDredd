#!/usr/bin/env bash
# Probe the deployed hook to verify the v0.1.295 confirmation->proposal
# fix is taking effect.
#
# Usage: DREDD_KEY=jaid_live_... harness/test-confirm-fix.sh
#
# Two-turn flow:
#  1. Register a substantive intent ("Refactor the auth module...").
#  2. Send a confirmation ("yes") with prior-assistant context.
# After (2) the hook should log
#   "...confirms previous proposal — adopting proposal as goal"
# (visible only in the container log, but the response should be 200 OK
# and /api/sessions/<id> should show the goal updated rather than stuck).

set -euo pipefail

: "${DREDD_KEY:?set DREDD_KEY=jaid_live_... before running}"

URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
SESSION="harness-confirm-$(date +%s)"

echo "session: $SESSION"
echo

echo "==> turn 1: register substantive goal"
curl -sk -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DREDD_KEY" \
  -d "{\"session_id\":\"$SESSION\",\"prompt\":\"Refactor the auth module to use JWT with RS256 signing\",\"hook_event_name\":\"UserPromptSubmit\"}" \
  "$URL/intent"
echo
echo

# The hook reads transcript_path server-side via fs.readFileSync, so
# pointing it at our local /tmp won't work. Use transcript_content
# (also accepted by /intent): inline JSONL of one assistant turn (the
# proposal) followed by one user turn (the "yes"). That populates
# priorAssistant on the server and triggers the new branch.
TRANSCRIPT_JSON=$(python3 -c '
import json
lines = [
    {"type":"user","message":{"content":"Refactor the auth module to use JWT with RS256 signing"}},
    {"type":"assistant","message":{"content":[{"type":"text","text":"Plan: 1) replace the bcrypt-only login flow with a JWT issuer signed RS256, 2) rotate keys via JWKS, 3) update the refresh-token endpoint to verify RS256 signatures. Start with step 1?"}]}},
    {"type":"user","message":{"content":"yes"}},
]
print("\n".join(json.dumps(l) for l in lines))
')

PAYLOAD=$(python3 -c "
import json, sys, os
print(json.dumps({
    'session_id': '$SESSION',
    'prompt': 'yes',
    'hook_event_name': 'UserPromptSubmit',
    'transcript_content': '''$TRANSCRIPT_JSON''',
}))")

echo "==> turn 2: send 'yes' with inline transcript_content"
curl -sk -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DREDD_KEY" \
  -d "$PAYLOAD" \
  "$URL/intent"
echo
echo

echo "==> session state (note originalTask + currentTask + last turnIntent)"
curl -sk \
  -H "Authorization: Bearer $DREDD_KEY" \
  "$URL/api/session-log/$SESSION" | python3 -m json.tool 2>/dev/null \
  | grep -E '"prompt"|"isConfirmation"|"originalTask"|"currentTask"' \
  | head -30 \
  || echo "(no JSON in response — likely auth or 404)"
