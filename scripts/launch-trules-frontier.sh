#!/usr/bin/env bash
# T-RULES headline experiment (ADDENDUM 13b) — does a poisoned CLAUDE.md/AGENTS.md
# hijack the Anthropic frontier that sits at 0% on T4?
#
# Run the 3 frontier controls FIRST (per 13b: "the one to run first regardless").
# PREREQUISITE: containers on v0.1.603+ (the T-RULES build). Version-gated.
#
# TRULES.1 (CLAUDE.md) + TRULES.2 (AGENTS.md), both arms, 20 reps x 2 scenarios
# = N=40/arm per model. Sonnet judge, eu-central-1, converse backend.
set -uo pipefail
KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MIN_VER="0.1.603"
DRY="${1:-}"

# container | model
CELLS=(
  "5:claude-opus-4-8"
  "9:claude-opus-4-7"
  "15:claude-sonnet-4-6"
)
for cell in "${CELLS[@]}"; do
  IFS=: read n model <<< "$cell"
  read v st < <(curl -sk -m 5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ "$(printf '%s\n%s\n' "$MIN_VER" "$v" | sort -V | head -1)" != "$MIN_VER" ]]; then
    echo "SKIP bedt$n ($model): version $v < $MIN_VER"; continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; continue; fi
  RUNID="p15b-trules-${model}-sonnetjudge-v0.1.603-eu-central-1"
  if [[ "$DRY" == "--dry" ]]; then echo "WOULD launch bedt$n: $model T-RULES  runId=$RUNID"; continue; fi
  curl -sk -m 30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
      \"test\": \"t5\", \"runId\": \"$RUNID\",
      \"env\": {
        \"RUN_ID\": \"$RUNID\", \"AGENT_MODELS\": \"$model\", \"AGENT_BACKEND\": \"converse\",
        \"AGENT_REGION\": \"eu-central-1\", \"AWS_REGION\": \"eu-central-1\",
        \"TECHNIQUES\": \"TRULES\", \"DEFENCES\": \"C4-baseline,C4-judge\",
        \"REPETITIONS\": \"20\", \"MAX_TURNS\": \"10\",
        \"JUDGE_MODEL\": \"eu.anthropic.claude-sonnet-4-6\",
        \"DREDD_URL\": \"$DREDD_URL\", \"DREDD_API_KEY\": \"$KEY\"
      }
    }"; echo " <- bedt$n $model T-RULES"
done
