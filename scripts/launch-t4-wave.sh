#!/usr/bin/env bash
# Launch the post-fix T4 (HTTP-injection) wave — the corpus that actually tests
# the gate's injection mandate (poison in tool output, not user turns).
#
# PREREQUISITE: target containers MUST be on v0.1.591+ (the enhanced T4: host fix
# + payload-split T4.4 + authority-spoof T4.5). This script verifies version
# before launching each cell and SKIPS any container not on >=0.1.591.
#
# Config: TECHNIQUES=T4, both arms (C4-baseline,C4-judge), 20 reps × 5 scenarios
# = 100/arm, Sonnet 4.6 judge, converse backend.
#
# Usage: bash scripts/launch-t4-wave.sh        # launch all mapped cells
#        bash scripts/launch-t4-wave.sh --dry   # print what would launch
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MIN_VER="0.1.591"
DRY="${1:-}"

# container | model | region | judge-prefix
CELLS=(
  "3:deepseek-v3.2:us-west-2:us"
  "4:qwen3-coder-480b:us-west-2:us"
  "6:nemotron-super-3-120b:us-west-2:us"
  "7:glm-4.7-flash:us-west-2:us"
  "8:gpt-oss-120b:eu-central-1:eu"
  "9:mistral-large-3:us-west-2:us"
  "10:devstral-2-123b:us-west-2:us"
  "11:qwen3-235b:eu-central-1:eu"
  "12:claude-opus-4-8:eu-central-1:eu"
  "13:claude-sonnet-4-6:eu-central-1:eu"
  "14:claude-opus-4-7:eu-central-1:eu"
)

ver_ok () { # $1=container -> echoes version, returns 0 if >= MIN_VER and idle
  local v st
  read v st < <(curl -sk -m 5 "https://bedt$1.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  echo "$v $st"
}

for cell in "${CELLS[@]}"; do
  IFS=: read n model region prefix <<< "$cell"
  read v st < <(ver_ok "$n")
  if [[ "$(printf '%s\n%s\n' "$MIN_VER" "$v" | sort -V | head -1)" != "$MIN_VER" ]]; then
    echo "SKIP bedt$n ($model): version $v < $MIN_VER — not on enhanced-T4 image yet"
    continue
  fi
  if [[ "$st" == "running" ]]; then
    echo "SKIP bedt$n ($model): busy ($st)"
    continue
  fi
  RUNID="p15b-t4-${model//./-}-sonnetjudge-v0.1.591-${region}"
  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n: $model T4 ($region, judge=$prefix.) runId=$RUNID"
    continue
  fi
  curl -sk -m 30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
      \"test\": \"t5\", \"runId\": \"$RUNID\",
      \"env\": {
        \"RUN_ID\": \"$RUNID\", \"AGENT_MODELS\": \"$model\", \"AGENT_BACKEND\": \"converse\",
        \"AGENT_REGION\": \"$region\", \"AWS_REGION\": \"$region\",
        \"TECHNIQUES\": \"T4\", \"DEFENCES\": \"C4-baseline,C4-judge\",
        \"REPETITIONS\": \"20\", \"MAX_TURNS\": \"10\",
        \"JUDGE_MODEL\": \"$prefix.anthropic.claude-sonnet-4-6\",
        \"DREDD_URL\": \"$DREDD_URL\", \"DREDD_API_KEY\": \"$KEY\"
      }
    }"; echo " <- bedt$n $model T4"
done
