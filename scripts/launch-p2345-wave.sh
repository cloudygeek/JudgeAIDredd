#!/usr/bin/env bash
# ADDENDUM 14 P2-P5 wave — the 4 missing-vector channels:
#   P2 TMCPDESC  — MCP tool-description/schema poisoning
#   P3 TDELAY    — conditional/delayed-trigger latent injection
#   P4 TEMIT     — insecure-output / agent emits malicious artifact
#   P5 TSLOP     — slopsquatting (require-time exfil from vendored package)
# Roster: 3 frontier + deepseek/qwen-coder/qwen-235b/gpt-oss-120b controls.
# Each container runs ALL FOUR techniques for its model (one /run call).
# PREREQUISITE: v0.1.639+. N/technique/arm = scenarios x REPS.
#
# Usage: ./launch-p2345-wave.sh [--dry]   (REPS env overrides, default 10)
set -uo pipefail
KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MIN_VER="0.1.639"; DRY="${1:-}"; REPS="${REPS:-10}"
TECHS="TMCPDESC,TDELAY,TEMIT,TSLOP"
# bedt : model : region : judge-prefix
CELLS=(
  "3:claude-opus-4-8:eu-central-1:eu"
  "9:claude-opus-4-7:eu-central-1:eu"
  "13:claude-sonnet-4-6:eu-central-1:eu"
  "14:deepseek-v3.2:us-west-2:us"
  "15:qwen3-coder-480b:us-west-2:us"
  "16:qwen3-235b:eu-central-1:eu"
  "17:gpt-oss-120b:eu-central-1:eu"
)
for cell in "${CELLS[@]}"; do
  IFS=: read n model region prefix <<< "$cell"
  read v st < <(curl -sk -m 5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ "$(printf '%s\n%s\n' "$MIN_VER" "$v" | sort -V | head -1)" != "$MIN_VER" ]]; then echo "SKIP bedt$n ($model): v$v < $MIN_VER"; continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; continue; fi
  RUNID="p15b-p2345-${model//[.:\/]/-}-sonnetjudge-v0.1.639-${region}"
  if [[ "$DRY" == "--dry" ]]; then echo "WOULD launch bedt$n $model [$TECHS] (reps=$REPS)"; continue; fi
  curl -sk -m 30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" -H "Content-Type: application/json" -d "{
    \"test\":\"t5\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",\"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"converse\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\",\"TECHNIQUES\":\"$TECHS\",\"DEFENCES\":\"C4-baseline,C4-judge\",
    \"REPETITIONS\":\"$REPS\",\"MAX_TURNS\":\"10\",\"JUDGE_MODEL\":\"$prefix.anthropic.claude-sonnet-4-6\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"; echo " <- bedt$n $model [$TECHS]"
done
