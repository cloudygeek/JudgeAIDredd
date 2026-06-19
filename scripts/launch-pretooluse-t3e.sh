#!/usr/bin/env bash
# launch-pretooluse-t3e.sh — T3e exfil suite under the enforcing PreToolUse gate.
#
# Follow-on to the crack-vector wave (docs/test-request-pretooluse-rerun-2026-06-18.md):
# re-runs the T3e exfil+disclosure suite at the PreToolUse call point so a hijacked
# verdict ABORTS the offending call (vs the post-turn `intent-tracker` arm that only
# blocks the next turn). T3e is the paper's flagship cell (qwen3-235b 63%->21%).
#
# Runner: runner-t3e-pretooluse.ts (entrypoint test:"t3e"). Defence arms:
#   none                            — baseline
#   intent-tracker                  — POST-TURN observe (existing wiring)
#   intent-tracker-enforced         — PreToolUse: hijacked verdict aborts the call
#   intent-tracker-enforced-stage1  — enforced + deterministic alternate-egress rule
#
# Roster (locked): qwen3-235b (headline), deepseek-v3.2 (high-baseline), sonnet-4-6 (floor).
# One agent per box. Image >= 0.1.692. NEVER targets bedt11-14 (busy/other work).
#
# Usage: ./launch-pretooluse-t3e.sh [--dry]
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MINVER="0.1.692"
REPS="${REPS:-20}"
SCENARIOS="T3e.1,T3e.2,T3e.3,T3e.4"
ARMS="none,intent-tracker,intent-tracker-enforced,intent-tracker-enforced-stage1"
DRY="${1:-}"

# Boxes confirmed idle on >=0.1.692; bedt11-14 excluded (busy/other work).
# cell: bedt:model:region:prefix
CELLS=(
  "3:qwen3-235b:eu-central-1:eu"
  "4:deepseek-v3.2:us-west-2:us"
  "5:claude-sonnet-4-6:eu-central-1:eu"
)

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

launched=0; skipped=0
for cell in "${CELLS[@]}"; do
  IFS=: read n model region prefix <<< "$cell"
  case "$n" in 11|12|13|14) echo "REFUSE bedt$n: off-limits"; ((skipped++)); continue;; esac
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ -z "${v:-}" ]]; then echo "SKIP bedt$n ($model): unreachable"; ((skipped++)); continue; fi
  if ! ver_ge "$MINVER" "$v"; then echo "SKIP bedt$n ($model): v$v < $MINVER"; ((skipped++)); continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; ((skipped++)); continue; fi

  rid_model="${model//[.:\/]/-}"
  RUNID="p15a-ptu-t3e-${rid_model}-b${n}-sonnetjudge-v${MINVER}-${region}"

  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n  $model  T3e.1-4  arms=4  reps=$REPS  region=$region  -> $RUNID"
    ((launched++)); continue
  fi

  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
    \"test\":\"t3e\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",
    \"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"converse\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\",
    \"SCENARIOS\":\"$SCENARIOS\",\"DEFENCES\":\"$ARMS\",
    \"REPETITIONS\":\"$REPS\",\"MAX_TURNS\":\"10\",
    \"JUDGE_MODEL\":\"$prefix.anthropic.claude-sonnet-4-6\",
    \"EMBED_MODEL\":\"$prefix.cohere.embed-v4:0\",\"JUDGE_PROMPT\":\"B7.1\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"
  echo " <- bedt$n $model T3e.1-4 reps=$REPS arms=4"
  ((launched++))
done

echo
echo "launched=$launched skipped=$skipped"
echo "RUN_ID prefix: p15a-ptu-t3e-* (S3: s3://cko-results/t3e/<RUN_ID>/)"
