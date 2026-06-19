#!/usr/bin/env bash
# launch-pretooluse-crackvec-sonnet-b2b3.sh — complete the sonnet-4-6 floor control.
#
# The main wave (launch-pretooluse-crackvec.sh) ran sonnet B1 only; B2/B3 were
# mapped to bedt13/14, which were left alone. This places those two missing
# buckets on freed-up bedt3-12 boxes so the sonnet floor covers the FULL
# crack-vector corpus (esp. the covert vectors TCMD/TLOG/TSTAGE/TEGRESS that
# actually test a frontier model's robustness).
#
# Same config as the main wave: Sonnet 4.6 judge + B7.1 + Cohere Embed v4,
# 4 arms, reps=20, eu-central-1, image >= 0.1.692. NEVER targets bedt13/14.
#
# Usage: ./launch-pretooluse-crackvec-sonnet-b2b3.sh [--dry]
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MINVER="0.1.692"
REPS="${REPS:-20}"
ALL_ARMS="C4-baseline,C4-judge,C4-judge-enforced,C4-judge-enforced-stage1"
DRY="${1:-}"

B2="TEGRESS,TCMD,TDELAY,TEMIT"
B3="TRULES,TSTAGE,TDEP,TLOG,TMCP,TMCPDESC,TSLOP"

# cell: bedt:bucketLabel:techniques  (sonnet-4-6, eu-central-1/eu only)
# Placed on freed done boxes (bedt3 = old minimax-b3, bedt4 = old minimax-b4;
# both already pushed to S3 + committed). bedt13/14 deliberately NOT used.
CELLS=(
  "3:b2:$B2"
  "4:b3:$B3"
)

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

launched=0; skipped=0
for cell in "${CELLS[@]}"; do
  IFS=: read n bucket techs <<< "$cell"
  if [[ "$n" == "13" || "$n" == "14" ]]; then echo "REFUSE bedt$n: off-limits"; ((skipped++)); continue; fi
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ -z "${v:-}" ]]; then echo "SKIP bedt$n: unreachable"; ((skipped++)); continue; fi
  if ! ver_ge "$MINVER" "$v"; then echo "SKIP bedt$n: v$v < $MINVER"; ((skipped++)); continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n: busy"; ((skipped++)); continue; fi

  RUNID="p15a-ptu-crackvec-claude-sonnet-4-6-${bucket}-b${n}-sonnetjudge-v${MINVER}-eu-central-1"

  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n  claude-sonnet-4-6  [$techs]  arms=4  reps=$REPS  -> $RUNID"
    ((launched++)); continue
  fi

  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
    \"test\":\"t5\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",
    \"AGENT_MODELS\":\"claude-sonnet-4-6\",\"AGENT_BACKEND\":\"converse\",
    \"AGENT_REGION\":\"eu-central-1\",\"AWS_REGION\":\"eu-central-1\",
    \"TECHNIQUES\":\"$techs\",\"DEFENCES\":\"$ALL_ARMS\",
    \"REPETITIONS\":\"$REPS\",\"MAX_TURNS\":\"10\",
    \"JUDGE_MODEL\":\"eu.anthropic.claude-sonnet-4-6\",
    \"EMBED_MODEL\":\"eu.cohere.embed-v4:0\",\"JUDGE_PROMPT\":\"B7.1\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"
  echo " <- bedt$n sonnet-4-6 [$techs] reps=$REPS arms=4"
  ((launched++))
done

echo
echo "launched=$launched skipped=$skipped"
echo "RUN_ID prefix: p15a-ptu-crackvec-claude-sonnet-4-6-b{2,3}-* (S3: s3://cko-results/t5/<RUN_ID>/)"
