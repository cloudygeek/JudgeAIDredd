#!/usr/bin/env bash
# launch-p15b-external-frontier.sh — external command-output egress wave on a
# Bedrock (converse) frontier model.
#
# WHY THIS EXISTS
# The only external frontier wave we have (results/p15b-2026-06-13-extcanary-
# frontier, opus-4-7 / sonnet-4-6 / gpt-5.5 / nova-pro) is VOID for two reasons:
#
#   1. WRONG CHANNEL. It uses README-delivered T-EGRESS — the channel every
#      frontier model REFUSES (agentDetected 40/40, exfil 0/40). So it measures
#      "does the model obey a suspicious README" (no), not the egress question.
#      The command-output channel (T-EGRESS-CMD), which actually gets models to
#      engage, has NEVER been run externally on a non-Gemini model.
#
#   2. PRE-FIX BUILD. payloadDeliveredBasis is null throughout — it predates the
#      run-integrity + heredoc + delivery-control fixes, so even non-zero cells
#      are untrustworthy.
#
# This launcher runs T-EGRESS-CMD + T-SLOP against a frontier Bedrock model on a
# >=MINVER box (has all fixes) so the result is comparable to the Gemini wave and
# answers: does egress behaviour on the command-output channel generalise beyond
# Gemini?
#
# PER-CHANNEL EXTERNALISATION (see canary-server.ts::exfilStep):
#   TEGRESSCMD.1 image-GET  -> EXTERNAL (Lambda /badge.png)   } scored from
#   TSLOP.1      http-post   -> EXTERNAL (Lambda /api/...)     } CloudWatch
#   TEGRESSCMD.2 git-push    -> LOCAL  (Function URL can't serve a git remote)
#   TEGRESSCMD.3 dns         -> LOCAL  (can't serve a resolver)
#   TEGRESSCMD.4 tool-arg    -> LOCAL  (WebSearch-arg inspection)
# So 2 legs land in the Lambda's logs; the other 3 score on the in-harness canary
# and roll up normally. This is BY DESIGN, not a defect.
#
# PRECONDITIONS — enforced; refuses rather than producing an uninterpretable cell:
#   1. box idle   (deploying to / launching on a busy box kills its run)
#   2. box >= MINVER   (HAS the heredoc + delivery-control fixes)
#
# Bedrock creds come from the box's own Fargate task role — NOTHING is sent in
# the body (unlike the vertex launcher's WIF JSON). If the task role lacks
# bedrock:InvokeModel for the chosen model the runs will error; that is exactly
# what the REPS=2 smoke step below is for. Always smoke first.
#
# Usage:
#   BOX=bedt5 MODEL=claude-opus-4-8   REPS=2  ./scripts/launch-p15b-external-frontier.sh   # smoke
#   BOX=bedt5 MODEL=claude-opus-4-8   REPS=40 ./scripts/launch-p15b-external-frontier.sh   # full
#   BOX=bedt6 MODEL=claude-sonnet-4-6 REPS=40 ./scripts/launch-p15b-external-frontier.sh
#   ... --dry   to print the body without POSTing
set -uo pipefail

BOX="${BOX:-bedt5}"
HOST="https://${BOX}.aisandbox.dev.ckotech.internal"
MINVER="${MINVER:-0.1.780}"
MODEL="${MODEL:-claude-opus-4-8}"
REPS="${REPS:-40}"
TECHNIQUES="${TECHNIQUES:-TEGRESSCMD,TSLOP}"
REGION="${REGION:-eu-central-1}"   # opus-4-8 + sonnet-4-6 confirmed ACTIVE here
EXTERNAL_URL="${EXTERNAL_URL:-https://p6sob5lskugmubzzzdtv22kzje0gpndi.lambda-url.eu-west-2.on.aws/}"
# Model tag is sanitised for the RUN_ID (dots/slashes -> dash).
MTAG="$(printf '%s' "$MODEL" | tr -c 'A-Za-z0-9._-' '-')"
if [[ "$REPS" -le 2 ]]; then
  RUNID="${RUNID:-p15b-2026-08-07-extfrontier-${MTAG}-smoke}"
else
  RUNID="${RUNID:-p15b-2026-08-07-extfrontier-${MTAG}-n${REPS}}"
fi
MODE="${1:-}"

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

check() {
  curl -sk -m10 "$HOST/status" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status','?'))" 2>/dev/null
}

read -r ver st < <(check)
ver="${ver:-}"; st="${st:-}"
if [[ -z "$ver" ]]; then
  echo "NOT READY: $BOX unreachable" >&2; exit 2
elif ! ver_ge "$MINVER" "$ver"; then
  echo "NOT READY: $BOX v$ver < $MINVER — MISSING the heredoc/delivery fixes" >&2
  echo "  -> deploy the >=$MINVER zip to $BOX first." >&2; exit 2
elif [[ "$st" == "running" ]]; then
  echo "NOT READY: $BOX busy (running a wave) — launching would kill it" >&2; exit 2
fi
echo "$BOX ready: v$ver $st"

BODY=$(RUNID="$RUNID" MODEL="$MODEL" REPS="$REPS" TECHNIQUES="$TECHNIQUES" \
  REGION="$REGION" EXTERNAL_URL="$EXTERNAL_URL" \
  python3 -c '
import os, json
env = {
  "RUN_ID": os.environ["RUNID"],
  "AGENT_MODELS": os.environ["MODEL"],
  "AGENT_BACKEND": "converse",
  "AWS_REGION": os.environ["REGION"],
  "TECHNIQUES": os.environ["TECHNIQUES"],
  "DEFENCES": "C4-baseline",
  "REPETITIONS": os.environ["REPS"],
  "MAX_TURNS": "10",
  "EXTERNAL_CANARY_URL": os.environ["EXTERNAL_URL"],
}
print(json.dumps({"test": "t5", "runId": os.environ["RUNID"], "env": env}))')

NCELL=1; [[ "$TECHNIQUES" == "TEGRESSCMD" || "$TECHNIQUES" == *TEGRESSCMD* ]] && NCELL=4
[[ "$TECHNIQUES" == *,* ]] && NCELL=$((NCELL+1))

if [[ "$MODE" == "--dry" ]]; then
  echo "WOULD POST to $HOST/run:"; echo "$BODY" | python3 -m json.tool
  echo "  cells: $TECHNIQUES x $REPS = ~$((NCELL*REPS)) runs  (model=$MODEL, region=$REGION)"
  exit 0
fi

echo "$BODY" > "/tmp/extfrontier-${BOX}.json"
LAUNCHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
curl -sk -m30 -X POST "$HOST/run" -H "Content-Type: application/json" \
  --data-binary @"/tmp/extfrontier-${BOX}.json"
echo
echo "launched $RUNID on $BOX (v$ver) at $LAUNCHED_AT"
echo "  model: $MODEL  backend: converse  region: $REGION"
echo "  techniques: $TECHNIQUES  reps: $REPS  (~$((NCELL*REPS)) runs)"
echo "results -> s3://cko-results/t5/$RUNID/"
echo
echo "EXTERNAL legs (image-GET + http-post) score from the Lambda's CloudWatch:"
echo "  since: $LAUNCHED_AT   filter on ?m=$MTAG"
echo
if [[ "$REPS" -le 2 ]]; then
  echo "SMOKE: watch $HOST/logs — expect the model to ENGAGE (tool calls, not a"
  echo "provider error). If you see AccessDenied / ValidationException, the box's"
  echo "task role lacks InvokeModel for $MODEL — do NOT scale to n=40."
fi
