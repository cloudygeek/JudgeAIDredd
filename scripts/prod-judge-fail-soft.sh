#!/bin/bash
# prod-judge-fail-soft.sh — live judge FAIL-SOFT rate from prod CloudWatch.
#
# Measures the "silent allow" half of the p19 refusal question: how often the
# Bedrock judge call THREW and fell back to drifting (allowed) instead of
# returning a verdict. The catch block in intent-judge.ts logs
#   [intent-judge] fail-soft: <msg>          (stderr)  ← numerator
# and every judge-invoked call logs
#   judge=<verdict>(<ms>ms in=.../...)        (stdout)  ← denominator
# Both land in the same CloudWatch group, so the rate is a two-query job.
#
# NOTE: this captures only the THROW path (outage / guardrail / BYOT exhaust).
# An in-band safety refusal ("I can't analyse that") is returned by Bedrock as
# normal content, fails CLOSED to hijacked, and reads as judge=hijacked here —
# indistinguishable from a real hijack in the stdout line. To measure THOSE,
# pull session JSON (dashboard /api/session-log/:id or a Dynamo scan) and run
#   npx tsx scripts/judge-refusal-rate.ts <files>
# which fingerprints the fail-closed reason + refusal language.
#
# Usage:  ./scripts/prod-judge-fail-soft.sh [lookback-days] [log-group] [region]
# Needs:  valid AWS creds (run `aws sso login` first).
set -euo pipefail

DAYS="${1:-7}"
LOG_GROUP="${2:-/ecs/judge-ai-dredd-prod/hook}"
REGION="${3:-eu-west-1}"
NOW=$(date +%s)
START=$(( NOW - DAYS * 86400 ))

run_query() {
  # $1 = Insights query string → echoes the single numeric stat
  local q="$1" qid
  qid=$(aws logs start-query --region "$REGION" \
        --log-group-name "$LOG_GROUP" \
        --start-time "$START" --end-time "$NOW" \
        --query-string "$q" --query 'queryId' --output text)
  local status="Running"
  while [ "$status" = "Running" ] || [ "$status" = "Scheduled" ]; do
    sleep 1
    status=$(aws logs get-query-results --region "$REGION" --query-id "$qid" \
             --query 'status' --output text)
  done
  aws logs get-query-results --region "$REGION" --query-id "$qid" \
    --query 'results[0][?field==`n`].value | [0]' --output text
}

echo "Log group: $LOG_GROUP  region: $REGION  window: last ${DAYS}d"
echo "Querying CloudWatch Logs Insights (this scans the whole window)…"

FAILSOFT=$(run_query 'filter @message like /\[intent-judge\] fail-soft/ | stats count() as n')
JUDGE=$(run_query 'filter @message like /judge=/ | stats count() as n')

FAILSOFT=${FAILSOFT:-0}; JUDGE=${JUDGE:-0}
echo
echo "  judge calls (judge= lines):     ${JUDGE}"
echo "  fail-soft (silent allow):       ${FAILSOFT}"
if [ "${JUDGE:-0}" != "0" ] && [ "${JUDGE:-0}" != "None" ]; then
  awk -v f="$FAILSOFT" -v j="$JUDGE" 'BEGIN{ printf "  fail-soft rate:                 %.3f%%\n", (100*f)/j }'
fi
echo
echo "  (For in-band refusals → hijacked, scan session JSON with judge-refusal-rate.ts.)"
