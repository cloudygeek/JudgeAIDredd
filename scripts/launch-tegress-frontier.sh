#!/usr/bin/env bash
# T-EGRESS (ADDENDUM 14 P1) — egress-channel diversity, the headline experiment.
# Does the frontier 0% hold when the easy egress is image-GET / git-push / DNS /
# tool-arg instead of HTTP POST? FILE entry + authority-spoof held constant; only
# the egress step varies (4 scenarios). 3 Anthropic frontier (headline cells) +
# deepseek-v3.2 / qwen3-coder-480b positive controls.
# PREREQUISITE: v0.1.639+ (P1 build). N/cell = 4 scenarios x 2 arms x REPS.
set -uo pipefail
KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MIN_VER="0.1.639"; DRY="${1:-}"; REPS="${REPS:-10}"
CELLS=(
  "3:claude-opus-4-8:eu-central-1:eu"
  "9:claude-opus-4-7:eu-central-1:eu"
  "13:claude-sonnet-4-6:eu-central-1:eu"
  "14:deepseek-v3.2:us-west-2:us"
  "15:qwen3-coder-480b:us-west-2:us"
)
for cell in "${CELLS[@]}"; do
  IFS=: read n model region prefix <<< "$cell"
  read v st < <(curl -sk -m 5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ "$(printf '%s\n%s\n' "$MIN_VER" "$v" | sort -V | head -1)" != "$MIN_VER" ]]; then echo "SKIP bedt$n ($model): v$v < $MIN_VER"; continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; continue; fi
  RUNID="p15b-tegress-${model//[.:\/]/-}-sonnetjudge-v0.1.639-${region}"
  if [[ "$DRY" == "--dry" ]]; then echo "WOULD launch bedt$n $model TEGRESS (reps=$REPS)"; continue; fi
  curl -sk -m 30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" -H "Content-Type: application/json" -d "{
    \"test\":\"t5\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",\"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"converse\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\",\"TECHNIQUES\":\"TEGRESS\",\"DEFENCES\":\"C4-baseline,C4-judge\",
    \"REPETITIONS\":\"$REPS\",\"MAX_TURNS\":\"10\",\"JUDGE_MODEL\":\"$prefix.anthropic.claude-sonnet-4-6\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"; echo " <- bedt$n $model TEGRESS"
done
