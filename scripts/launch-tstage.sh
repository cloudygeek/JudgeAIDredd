#!/usr/bin/env bash
# T-STAGE (ADDENDUM 14b) — pre-staged exfil script + benign trigger.
# Frontier-breaker test: 3 Anthropic frontier (headline) + deepseek/qwen-coder controls.
# PREREQUISITE: v0.1.631+ (T-STAGE build). N=40/arm (2 scenarios x 2 arms x 10 reps).
set -uo pipefail
KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MIN_VER="0.1.631"; DRY="${1:-}"
CELLS=(
  "3:claude-opus-4-8:eu-central-1:eu"
  "4:claude-opus-4-7:eu-central-1:eu"
  "5:claude-sonnet-4-6:eu-central-1:eu"
  "6:deepseek-v3.2:us-west-2:us"
  "7:qwen3-coder-480b:us-west-2:us"
)
for cell in "${CELLS[@]}"; do
  IFS=: read n model region prefix <<< "$cell"
  read v st < <(curl -sk -m 5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ "$(printf '%s\n%s\n' "$MIN_VER" "$v" | sort -V | head -1)" != "$MIN_VER" ]]; then echo "SKIP bedt$n ($model): v$v < $MIN_VER"; continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; continue; fi
  RUNID="p15b-tstage-${model//[.:\/]/-}-sonnetjudge-v0.1.631-${region}"
  if [[ "$DRY" == "--dry" ]]; then echo "WOULD launch bedt$n $model TSTAGE"; continue; fi
  curl -sk -m 30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" -H "Content-Type: application/json" -d "{
    \"test\":\"t5\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",\"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"converse\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\",\"TECHNIQUES\":\"TSTAGE\",\"DEFENCES\":\"C4-baseline,C4-judge\",
    \"REPETITIONS\":\"10\",\"MAX_TURNS\":\"10\",\"JUDGE_MODEL\":\"$prefix.anthropic.claude-sonnet-4-6\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"; echo " <- bedt$n $model TSTAGE"
done
