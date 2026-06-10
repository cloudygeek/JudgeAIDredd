#!/usr/bin/env bash
# Launch AWS-native (Amazon Nova) T3e + T5 cells — closes the "every Bedrock
# vendor but the host" gap.
#
# PREREQUISITE: target containers MUST be on v0.1.593+ (the build that adds the
# Nova model-map entries). Version-gated + idle-checked; skips otherwise.
#
# nova-pro (capable) + nova-2-lite (current-gen lite), eu-central-1, Sonnet judge.
#   T3e: none + intent-tracker, N=80 (4 scenarios x 20)
#   T5 : C4-baseline + C4-judge, N=60 (3 scenarios x 20)
#
# Usage: bash scripts/launch-nova-wave.sh [--dry]
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MIN_VER="0.1.593"
DRY="${1:-}"

# container | model | test(t3e|t5)
CELLS=(
  "5:nova-pro:t3e"
  "15:nova-pro:t5"
  "16:nova-2-lite:t3e"
  "17:nova-2-lite:t5"
)

for cell in "${CELLS[@]}"; do
  IFS=: read n model test <<< "$cell"
  read v st < <(curl -sk -m 5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ "$(printf '%s\n%s\n' "$MIN_VER" "$v" | sort -V | head -1)" != "$MIN_VER" ]]; then
    echo "SKIP bedt$n ($model $test): version $v < $MIN_VER — not on Nova image yet"; continue
  fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model $test): busy ($st)"; continue; fi

  if [[ "$test" == "t3e" ]]; then
    RUNID="p15b-t3e-${model}-sonnetjudge-v0.1.593-eu-central-1"
    ENV="\"DEFENCES\":\"none,intent-tracker\",\"SCENARIOS\":\"T3e.1,T3e.2,T3e.3,T3e.4\",\"JUDGE_PROMPT\":\"B7.1\","
  else
    RUNID="p15b-t5-${model}-sonnetjudge-v0.1.593-eu-central-1"
    ENV="\"TECHNIQUES\":\"T5\",\"DEFENCES\":\"C4-baseline,C4-judge\","
  fi

  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n: $model $test  runId=$RUNID"; continue
  fi
  curl -sk -m 30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
      \"test\": \"$test\", \"runId\": \"$RUNID\",
      \"env\": {
        \"RUN_ID\": \"$RUNID\", \"AGENT_MODELS\": \"$model\", \"AGENT_BACKEND\": \"converse\",
        \"AGENT_REGION\": \"eu-central-1\", \"AWS_REGION\": \"eu-central-1\",
        $ENV
        \"REPETITIONS\": \"20\", \"MAX_TURNS\": \"10\",
        \"JUDGE_MODEL\": \"eu.anthropic.claude-sonnet-4-6\",
        \"DREDD_URL\": \"$DREDD_URL\", \"DREDD_API_KEY\": \"$KEY\"
      }
    }"; echo " <- bedt$n $model $test"
done
