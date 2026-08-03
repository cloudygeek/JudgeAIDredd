#!/usr/bin/env bash
# launch-p15b-trules-rerun.sh — the second half of the p15b void-channel re-run.
#
# WHY THIS EXISTS
# The Gemini injection-map cells for T-CMD / T-LOG / T-DEP / T-RULES were void:
# executor-vertex.ts never seeded the scenario's `workspaceFiles`, so the file
# carrying the injection did not exist and the attack was never delivered. Those
# cells published a clean 0% that read as robustness (fixed in f1c1899e3; the
# §3 run-integrity controls that now catch it are in 93e0a5aab).
#
# bedt5 takes T-CMD + T-LOG + T-DEP (320 runs). This script takes the remaining
# T-RULES pair on bedt3 once its old tier1a wave finishes.
#
# PRECONDITIONS — the script enforces all of them, and refuses rather than
# producing another void cell:
#   1. bedt3 is idle (not mid-run)
#   2. bedt3 is on >= MINVER, i.e. it HAS the workspaceFiles fix. Running this
#      on 0.1.754 would silently reproduce the exact bug we are fixing.
#   3. gcp-wif.json is present locally
#
# Usage:
#   ./scripts/launch-p15b-trules-rerun.sh            # launch if ready
#   ./scripts/launch-p15b-trules-rerun.sh --wait     # poll until ready, then launch
#   ./scripts/launch-p15b-trules-rerun.sh --dry      # show what would be sent
set -uo pipefail

BOX="${BOX:-bedt3}"
HOST="https://${BOX}.aisandbox.dev.ckotech.internal"
# 0.1.761 = workspaceFiles fix (f1c1899e3) + §3 run-integrity controls (93e0a5aab).
MINVER="${MINVER:-0.1.761}"
REPS="${REPS:-80}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WIF_FILE="${WIF_FILE:-$PROJECT_ROOT/gcp-wif.json}"
RUNID="${RUNID:-p15b-2026-08-03-gemini-map-rerun-trules-n80}"
MODE="${1:-}"

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

if [[ ! -f "$WIF_FILE" ]]; then
  echo "FATAL: WIF config not found at $WIF_FILE" >&2
  echo "  regenerate with:" >&2
  echo "  gcloud iam workload-identity-pools create-cred-config \\" >&2
  echo "    projects/756445098969/locations/global/workloadIdentityPools/cko-aws/providers/ai-sandbox \\" >&2
  echo "    --service-account=test-vertex@sys-66937732661944501347517615.iam.gserviceaccount.com \\" >&2
  echo "    --aws --output-file=gcp-wif.json" >&2
  exit 1
fi

check() {
  # -> "version status"
  curl -sk -m10 "$HOST/status" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status','?'))" 2>/dev/null
}

attempt=0
while true; do
  read -r ver st < <(check)
  ver="${ver:-}"; st="${st:-}"

  if [[ -z "$ver" ]]; then
    reason="unreachable"
  elif ! ver_ge "$MINVER" "$ver"; then
    reason="v$ver < $MINVER — MISSING the workspaceFiles fix; would produce another VOID cell"
  elif [[ "$st" == "running" ]]; then
    reason="busy (still running a wave)"
  else
    break
  fi

  if [[ "$MODE" != "--wait" ]]; then
    echo "NOT READY: $BOX $reason" >&2
    [[ "$reason" == *"MISSING the workspaceFiles fix"* ]] && \
      echo "  -> deploy the >=$MINVER image to $BOX before running this." >&2
    exit 2
  fi
  attempt=$((attempt+1))
  echo "[$attempt] $BOX not ready: $reason — sleeping 120s"
  sleep 120
done

echo "$BOX ready: v$ver $st"

BODY=$(RUNID="$RUNID" REPS="$REPS" \
  WIF="$(python3 -c "
import json
c=json.load(open('$WIF_FILE'))
# credential_source points at EC2 IMDS (169.254.169.254), which does not exist on
# Fargate; executor-vertex.ts strips it and substitutes an ECS-aware supplier.
# It must ALSO be stripped here: sending those IMDS URLs trips an SSRF filter in
# the path and POST /run hangs (HTTP 000 after ~56s).
c.pop('credential_source', None)
print(json.dumps(c, separators=(',',':')))")" \
  python3 -c '
import os, json
env = {
  "RUN_ID": os.environ["RUNID"],
  "AGENT_MODELS": "gemini-3.1-pro-preview",
  "AGENT_BACKEND": "vertex",
  "VERTEX_REGION": "global",
  "GCP_PROJECT": "sys-66937732661944501347517615",
  "GCP_WIF_CONFIG_JSON": os.environ["WIF"],
  "AWS_REGION": "eu-central-1",
  "TECHNIQUES": "TRULES",
  "DEFENCES": "C4-baseline",
  "REPETITIONS": os.environ["REPS"],
  "MAX_TURNS": "10",
}
print(json.dumps({"test": "t5", "runId": os.environ["RUNID"], "env": env}))')

if [[ "$MODE" == "--dry" ]]; then
  echo "WOULD POST to $HOST/run:"
  echo "$BODY" | python3 -c "
import sys,json
d=json.load(sys.stdin)
d['env']['GCP_WIF_CONFIG_JSON']='<%d chars>' % len(d['env']['GCP_WIF_CONFIG_JSON'])
print(json.dumps(d,indent=2))"
  echo "  cells: TRULES.1 + TRULES.2 x $REPS = $((2*REPS)) runs"
  exit 0
fi

echo "$BODY" > /tmp/trules-rerun-body.json
curl -sk -m30 -X POST "$HOST/run" -H "Content-Type: application/json" \
  --data-binary @/tmp/trules-rerun-body.json
echo
echo "launched $RUNID on $BOX (v$ver) — TRULES.1 + TRULES.2 x $REPS = $((2*REPS)) runs"
echo "results -> s3://cko-results/t5/$RUNID/"
echo
echo "Check the SUMMARY lines for 'delivered=' > 0 and the absence of"
echo "'*** NOT REPORTABLE ***'. If a cell reports void-payload-undelivered, the"
echo "image predates the workspaceFiles fix — do not publish the rate."
