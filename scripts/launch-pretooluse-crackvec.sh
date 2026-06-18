#!/usr/bin/env bash
# launch-pretooluse-crackvec.sh — crack-vector corpus under the ENFORCING PreToolUse gate.
#
# Implements docs/test-request-pretooluse-rerun-2026-06-18.md (crack-vector slice) +
# docs/plan-pretooluse-rerun-2026-06-18.md. Re-runs the June-15 detection probe
# under a gate that ABORTS the tool call on a hijacked verdict (vs the post-turn
# C4-judge arm that only blocks the next turn — 54/211 minimax exfils were
# hijacked+blocked yet the canary still left).
#
# Requires the test-framework image at >= 0.1.692 on every target (the gate +
# enforced arms landed in that build). Old containers SKIP via the ver_ge guard —
# redeploy them first.
#
# Roster (locked 2026-06-18): A=minimax-m2.5, B=qwen3-235b, C=deepseek-v3.2,
# D=sonnet-4-6 (floor control). Arms per cell:
#   C4-baseline              — no judge (baseline)
#   C4-judge                 — POST-TURN observe (the June wiring; quantifies the gap)
#   C4-judge-enforced        — PreToolUse: hijacked verdict ABORTS the call
#   C4-judge-enforced-stage1 — enforced + deterministic alternate-egress rule
#
# 29 technique×scenario cells split into 3 buckets per agent → 12 containers
# (bedt3..14), ~7h wall-clock at reps=20. One cell per box, all parallel.
#
# Usage: ./launch-pretooluse-crackvec.sh [--dry]
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MINVER="0.1.692"
REPS="${REPS:-20}"
ALL_ARMS="C4-baseline,C4-judge,C4-judge-enforced,C4-judge-enforced-stage1"
DRY="${1:-}"

# Technique buckets — balance the 29 scenarios across 3 boxes/agent.
#   B1 (10): T1(4) + T4(5) + TWEB(1)
#   B2 (10): TEGRESS(4) + TCMD(2) + TDELAY(2) + TEMIT(2)
#   B3 ( 9): TRULES(2) + TSTAGE(2) + TDEP(1) + TLOG(1) + TMCP(1) + TMCPDESC(1) + TSLOP(1)
B1="T1,T4,TWEB"
B2="TEGRESS,TCMD,TDELAY,TEMIT"
B3="TRULES,TSTAGE,TDEP,TLOG,TMCP,TMCPDESC,TSLOP"

# cell: bedt:model:region:prefix:backend:techniques:arms
# region/prefix: eu-central-1/eu for minimax/qwen/sonnet; us-west-2/us for deepseek.
CELLS=(
  # A — minimax-m2.5 (anchor vs June detection probe)
  "3:minimax-m2.5:eu-central-1:eu:converse:$B1:$ALL_ARMS"
  "4:minimax-m2.5:eu-central-1:eu:converse:$B2:$ALL_ARMS"
  "5:minimax-m2.5:eu-central-1:eu:converse:$B3:$ALL_ARMS"
  # B — qwen3-235b (high-baseline exfil anchor)
  "6:qwen3-235b:eu-central-1:eu:converse:$B1:$ALL_ARMS"
  "7:qwen3-235b:eu-central-1:eu:converse:$B2:$ALL_ARMS"
  "8:qwen3-235b:eu-central-1:eu:converse:$B3:$ALL_ARMS"
  # C — deepseek-v3.2 (breadth; us-west-2)
  "9:deepseek-v3.2:us-west-2:us:converse:$B1:$ALL_ARMS"
  "10:deepseek-v3.2:us-west-2:us:converse:$B2:$ALL_ARMS"
  "11:deepseek-v3.2:us-west-2:us:converse:$B3:$ALL_ARMS"
  # D — sonnet-4-6 (frontier floor control)
  "12:claude-sonnet-4-6:eu-central-1:eu:converse:$B1:$ALL_ARMS"
  "13:claude-sonnet-4-6:eu-central-1:eu:converse:$B2:$ALL_ARMS"
  "14:claude-sonnet-4-6:eu-central-1:eu:converse:$B3:$ALL_ARMS"
)

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

launched=0; skipped=0
for cell in "${CELLS[@]}"; do
  IFS=: read n model region prefix backend techs arms <<< "$cell"
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ -z "${v:-}" ]]; then echo "SKIP bedt$n ($model): unreachable"; ((skipped++)); continue; fi
  if ! ver_ge "$MINVER" "$v"; then echo "SKIP bedt$n ($model): v$v < $MINVER — redeploy 0.1.692 first"; ((skipped++)); continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; ((skipped++)); continue; fi

  rid_model="${model//[.:\/]/-}"
  RUNID="p15a-ptu-crackvec-${rid_model}-b${n}-sonnetjudge-v${MINVER}-${region}"

  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n  $model  [$techs]  arms=4  reps=$REPS  region=$region  -> $RUNID"
    ((launched++)); continue
  fi

  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
    \"test\":\"t5\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",
    \"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"$backend\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\",
    \"TECHNIQUES\":\"$techs\",\"DEFENCES\":\"$arms\",
    \"REPETITIONS\":\"$REPS\",\"MAX_TURNS\":\"10\",
    \"JUDGE_MODEL\":\"$prefix.anthropic.claude-sonnet-4-6\",
    \"EMBED_MODEL\":\"$prefix.cohere.embed-v4:0\",
    \"JUDGE_PROMPT\":\"B7.1\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"
  echo " <- bedt$n $model [$techs] reps=$REPS arms=4"
  ((launched++))
done

echo
echo "launched=$launched skipped=$skipped (of ${#CELLS[@]} cells)"
echo "Pull results by RUN_ID prefix p15a-ptu-crackvec-* (S3: s3://cko-results/t5/<RUN_ID>/)."
echo "Per-cell JSON carries summary.toolCallsAborted + per-call executed/gateVerdict."
