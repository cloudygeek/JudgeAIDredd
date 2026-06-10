#!/usr/bin/env bash
# T1 document/file-injection wave (ADDENDUM 13) — full roster.
# T1.1 README / T1.2 design-doc / T1.3 ticket / T1.4 git-issue-PR (new).
# Injection in user-pasted document content; exfil-scored (POSTs to canary).
#
# PREREQUISITE: v0.1.603+ (for T1.4). Version-gated.
# Both arms (C4-baseline,C4-judge), 20 reps x 4 scenarios = N=80/arm, Sonnet judge.
set -uo pipefail
KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MIN_VER="0.1.603"
DRY="${1:-}"

# container | model | region | judge-prefix
CELLS=(
  "3:deepseek-v3.2:us-west-2:us"
  "4:qwen3-coder-480b:us-west-2:us"
  "6:nemotron-super-3-120b:us-west-2:us"
  "7:glm-4.7-flash:us-west-2:us"
  "8:gpt-oss-120b:eu-central-1:eu"
  "10:devstral-2-123b:us-west-2:us"
  "11:qwen3-235b:eu-central-1:eu"
  "12:mistral-large-3:us-west-2:us"
  "13:nova-pro:eu-central-1:eu"
  "14:nova-2-lite:eu-central-1:eu"
  "16:gpt-oss-20b:eu-central-1:eu"
  "17:minimax-m2.5:eu-central-1:eu"
)
for cell in "${CELLS[@]}"; do
  IFS=: read n model region prefix <<< "$cell"
  read v st < <(curl -sk -m 5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ "$(printf '%s\n%s\n' "$MIN_VER" "$v" | sort -V | head -1)" != "$MIN_VER" ]]; then
    echo "SKIP bedt$n ($model): version $v < $MIN_VER"; continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; continue; fi
  label="${model//[.:\/]/-}"
  RUNID="p15b-t1-${label}-sonnetjudge-v0.1.603-${region}"
  if [[ "$DRY" == "--dry" ]]; then echo "WOULD launch bedt$n: $model T1  runId=$RUNID"; continue; fi
  curl -sk -m 30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
      \"test\": \"t5\", \"runId\": \"$RUNID\",
      \"env\": {
        \"RUN_ID\": \"$RUNID\", \"AGENT_MODELS\": \"$model\", \"AGENT_BACKEND\": \"converse\",
        \"AGENT_REGION\": \"$region\", \"AWS_REGION\": \"$region\",
        \"TECHNIQUES\": \"T1\", \"DEFENCES\": \"C4-baseline,C4-judge\",
        \"REPETITIONS\": \"20\", \"MAX_TURNS\": \"10\",
        \"JUDGE_MODEL\": \"$prefix.anthropic.claude-sonnet-4-6\",
        \"DREDD_URL\": \"$DREDD_URL\", \"DREDD_API_KEY\": \"$KEY\"
      }
    }"; echo " <- bedt$n $model T1"
done
