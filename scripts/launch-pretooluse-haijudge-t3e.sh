#!/usr/bin/env bash
# launch-pretooluse-haijudge-t3e.sh — Cell C of the cost/FPR request:
# the open-weights T3e exfiltrators under a HAIKU 4.5 judge (vs the Sonnet 4.6
# judge used everywhere else), enforced PreToolUse call point.
#
# Implements docs/test-request-pretooluse-cost-fpr-2026-06-22.md §2(C): lets
# tab:judge-cmp (Haiku ~= Sonnet) be reported on the enforced call point.
# Identical to launch-pretooluse-openweights-t3e.sh EXCEPT the judge model is
# Haiku 4.5 and the run prefix is p15a-ptu-haijudge-t3e-*.
#
# Protocol: image >= 0.1.692, judge Haiku 4.5 + B7.1 + Cohere Embed v4,
# T3e.1-4 x20, 4 arms (none / intent-tracker / intent-tracker-enforced /
# intent-tracker-enforced-stage1). Region-aware judge/embed prefix.
#
# Usage: ./launch-pretooluse-haijudge-t3e.sh [--dry]
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MINVER="0.1.692"
REPS="${REPS:-20}"
SCENARIOS="T3e.1,T3e.2,T3e.3,T3e.4"
ARMS="none,intent-tracker,intent-tracker-enforced,intent-tracker-enforced-stage1"
HAIKU="anthropic.claude-haiku-4-5-20251001-v1:0"
DRY="${1:-}"

# Same roster + regions as the Sonnet-judge open-weights wave.
# cell: bedt:model:region
CELLS=(
  "3:glm-4.7-flash:eu-central-1"
  "4:nemotron-super-3-120b:eu-central-1"
  "5:gpt-oss-120b:eu-central-1"
  "6:devstral-2-123b:eu-central-1"
  "7:minimax-m2.5:eu-central-1"
  "8:qwen3-coder-next:us-east-1"
  "9:deepseek-v3.1:us-west-2"
  "10:glm-4.7:us-west-2"
  # 9th + others (qwen3-235b, deepseek-v3.2) defer to a re-run when boxes free.
  "PENDING:mistral-large-3:us-west-2"
  "PENDING:qwen3-235b:eu-central-1"
  "PENDING:deepseek-v3.2:us-west-2"
)

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }
prefix_for() { case "$1" in us-*) echo us;; ap-*) echo us;; *) echo eu;; esac; }

launched=0; skipped=0
for cell in "${CELLS[@]}"; do
  IFS=: read n model region <<< "$cell"
  if [[ "$n" == "PENDING" ]]; then echo "DEFER $model ($region): no free box this pass — re-run when one frees"; ((skipped++)); continue; fi
  case "$n" in 11|12|13|14) echo "REFUSE bedt$n: off-limits"; ((skipped++)); continue;; esac
  prefix=$(prefix_for "$region")
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ -z "${v:-}" ]]; then echo "SKIP bedt$n ($model): unreachable"; ((skipped++)); continue; fi
  if ! ver_ge "$MINVER" "$v"; then echo "SKIP bedt$n ($model): v$v < $MINVER"; ((skipped++)); continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; ((skipped++)); continue; fi

  rid_model="${model//[.:\/]/-}"
  RUNID="p15a-ptu-haijudge-t3e-${rid_model}-b${n}-haikujudge-v${MINVER}-${region}"

  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n  $model  T3e.1-4  arms=4  reps=$REPS  judge=${prefix}.${HAIKU}  -> $RUNID"
    ((launched++)); continue
  fi

  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
    \"test\":\"t3e\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",
    \"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"converse\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\",
    \"SCENARIOS\":\"$SCENARIOS\",\"DEFENCES\":\"$ARMS\",
    \"REPETITIONS\":\"$REPS\",\"MAX_TURNS\":\"10\",
    \"JUDGE_MODEL\":\"${prefix}.${HAIKU}\",
    \"EMBED_MODEL\":\"${prefix}.cohere.embed-v4:0\",\"JUDGE_PROMPT\":\"B7.1\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"
  echo " <- bedt$n $model T3e.1-4 reps=$REPS arms=4 HAIKU-judge $region"
  ((launched++))
done

echo
echo "launched=$launched skipped=$skipped"
echo "RUN_ID prefix: p15a-ptu-haijudge-t3e-* (S3: s3://cko-results/t3e/<RUN_ID>/)"
