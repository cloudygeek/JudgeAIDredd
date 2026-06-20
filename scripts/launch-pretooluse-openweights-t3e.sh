#!/usr/bin/env bash
# launch-pretooluse-openweights-t3e.sh — the remaining 9 open-weights agents,
# T3e under the enforcing PreToolUse gate.
#
# Implements docs/test-request-pretooluse-openweights-t3e-2026-06-20.md: finishes
# tab:exfil-defended under the correct (PreToolUse) call point. Qwen3-235B,
# DeepSeek-V3.2, and the Sonnet floor are already DONE
# (results/p15a-ptu-t3e-t4-t5-2026-06-19/); this runs the other 9.
#
# Protocol matches the completed cells EXACTLY: image >= 0.1.692, Sonnet 4.6 judge
# + B7.1 + Cohere Embed v4, T3e.1-4 x20 reps, 4 arms
# (none / intent-tracker / intent-tracker-enforced / intent-tracker-enforced-stage1).
#
# Region split (per p15b/model-access-2026-06-06.md):
#   eu-central-1: glm-4.7-flash, nemotron-super-3-120b, gpt-oss-120b, devstral-2-123b, minimax-m2.5
#   us-east-1:    qwen3-coder-next (us-east-1 ONLY)
#   us-west-2:    deepseek-v3.1, glm-4.7 (full), mistral-large-3
# Judge/embed prefix follows region (eu. / us.) — the t3e entrypoint derives it.
#
# 9 agents, 8 free boxes (bedt3-10; bedt11-14 OFF-LIMITS). The 9th cell SKIPs until
# a box frees — re-run to pick it up (busy/done boxes are skipped, so no dup).
#
# Usage: ./launch-pretooluse-openweights-t3e.sh [--dry]
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MINVER="0.1.692"
REPS="${REPS:-20}"
SCENARIOS="T3e.1,T3e.2,T3e.3,T3e.4"
ARMS="none,intent-tracker,intent-tracker-enforced,intent-tracker-enforced-stage1"
DRY="${1:-}"

# cell: bedt:model:region   (eu-central-1 first — faster; us-region cells are the long pole)
CELLS=(
  "3:glm-4.7-flash:eu-central-1"
  "4:nemotron-super-3-120b:eu-central-1"
  "5:gpt-oss-120b:eu-central-1"
  "6:devstral-2-123b:eu-central-1"
  "7:minimax-m2.5:eu-central-1"
  "8:qwen3-coder-next:us-east-1"
  "9:deepseek-v3.1:us-west-2"
  "10:glm-4.7:us-west-2"
  # 9th agent — placed on bedt3 in a re-run after the eu cells freed it (2026-06-20).
  "3:mistral-large-3:us-west-2"
)

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }
prefix_for() { case "$1" in us-*) echo us;; ap-*) echo us;; *) echo eu;; esac; }

launched=0; skipped=0
for cell in "${CELLS[@]}"; do
  IFS=: read n model region <<< "$cell"
  if [[ "$n" == "PENDING" ]]; then echo "DEFER $model ($region): no free box this pass (bedt11-14 off-limits) — re-run when one frees"; ((skipped++)); continue; fi
  case "$n" in 11|12|13|14) echo "REFUSE bedt$n: off-limits"; ((skipped++)); continue;; esac
  prefix=$(prefix_for "$region")
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ -z "${v:-}" ]]; then echo "SKIP bedt$n ($model): unreachable"; ((skipped++)); continue; fi
  if ! ver_ge "$MINVER" "$v"; then echo "SKIP bedt$n ($model): v$v < $MINVER"; ((skipped++)); continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; ((skipped++)); continue; fi

  rid_model="${model//[.:\/]/-}"
  RUNID="p15a-ptu-t3e-${rid_model}-b${n}-sonnetjudge-v${MINVER}-${region}"

  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n  $model  T3e.1-4  arms=4  reps=$REPS  region=$region (${prefix}.)  -> $RUNID"
    ((launched++)); continue
  fi

  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
    \"test\":\"t3e\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",
    \"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"converse\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\",
    \"SCENARIOS\":\"$SCENARIOS\",\"DEFENCES\":\"$ARMS\",
    \"REPETITIONS\":\"$REPS\",\"MAX_TURNS\":\"10\",
    \"JUDGE_MODEL\":\"${prefix}.anthropic.claude-sonnet-4-6\",
    \"EMBED_MODEL\":\"${prefix}.cohere.embed-v4:0\",\"JUDGE_PROMPT\":\"B7.1\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"
  echo " <- bedt$n $model T3e.1-4 reps=$REPS arms=4 region=$region"
  ((launched++))
done

echo
echo "launched=$launched skipped=$skipped"
echo "RUN_ID prefix: p15a-ptu-t3e-* (S3: s3://cko-results/t3e/<RUN_ID>/)"
echo "us-region cells (coder-next/deepseek-v3.1/glm-4.7/mistral-large-3) are the long pole."
