#!/usr/bin/env bash
# N-top-up wave — bring every below-target crack/egress cell to the agreed N:
#   zero-rate cells → N=80 (0/80 ⇒ "≤4.6%"); frontier crack cells → N=80 (rankable);
#   open-weights crack cells → N=40; TEGRESS targets are PER-EGRESS.
# reps sized so pooled (existing + this) reaches target. Distinct a16- RUN_IDs;
# pull routes by technique into existing tstage/p2345/tegress dirs.
#
# Usage: ./launch-ntopup.sh [--dry]
set -uo pipefail
KEY=$(cat ~/.claude/dredd/api-key)
OPENAI_KEY=$(cat openapi.key 2>/dev/null || cat "$(git rev-parse --show-toplevel)/openapi.key")
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
DRY="${1:-}"

# bedt:model:region:prefix:backend:techniques:reps:minver
CELLS=(
  "8:claude-opus-4-8:eu-central-1:eu:converse:TSLOP,TEGRESS:70:0.1.639"
  "9:claude-opus-4-7:eu-central-1:eu:converse:TSLOP,TEGRESS:70:0.1.639"
  "6:claude-sonnet-4-6:eu-central-1:eu:converse:TSLOP,TEGRESS:70:0.1.639"
  "7:eu.anthropic.claude-fable-5:eu-central-1:eu:converse:TSTAGE,TSLOP,TEMIT,TEGRESS:60:0.1.639"
  "3:gpt-5.5:eu-central-1:eu:openai:TSTAGE,TSLOP,TEMIT,TEGRESS:70:0.1.649"
  "14:deepseek-v3.2:us-west-2:us:converse:TEGRESS:30:0.1.639"
  "15:qwen3-coder-480b:us-west-2:us:converse:TEGRESS:30:0.1.639"
  "10:nova-pro:eu-central-1:eu:converse:TSTAGE,TSLOP,TEMIT,TEGRESS:80:0.1.639"
  "11:nova-2-lite:eu-central-1:eu:converse:TSTAGE,TSLOP,TEMIT,TEGRESS:80:0.1.639"
)
ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

for cell in "${CELLS[@]}"; do
  IFS=: read n model region prefix backend techs reps minver <<< "$cell"
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if ! ver_ge "$minver" "$v"; then echo "SKIP bedt$n ($model): v$v < $minver"; continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; continue; fi
  rid_model="${model//[.:\/]/-}"
  RUNID="p15b-a16-ntopup-${rid_model}-sonnetjudge-v0.1.659-${region}"
  if [[ "$DRY" == "--dry" ]]; then echo "WOULD launch bedt$n $model [$techs] reps=$reps backend=$backend"; continue; fi
  extra=""; [[ "$backend" == "openai" ]] && extra=",\"OPENAI_API_KEY\":\"$OPENAI_KEY\""
  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" -H "Content-Type: application/json" -d "{
    \"test\":\"t5\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",\"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"$backend\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\"$extra,\"TECHNIQUES\":\"$techs\",\"DEFENCES\":\"C4-baseline,C4-judge\",
    \"REPETITIONS\":\"$reps\",\"MAX_TURNS\":\"10\",\"JUDGE_MODEL\":\"$prefix.anthropic.claude-sonnet-4-6\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"; echo " <- bedt$n $model [$techs] reps=$reps"
done
