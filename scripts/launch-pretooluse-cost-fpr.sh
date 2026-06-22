#!/usr/bin/env bash
# launch-pretooluse-cost-fpr.sh — Cell A (FPR/utility) of the cost/FPR request.
#
# Implements docs/test-request-pretooluse-cost-fpr-2026-06-22.md §2A: runs the
# 10-task legitimate developer workload under the enforcing PreToolUse gate, so
# we can measure (i) hijacked-deny FPR (legitimate calls wrongly aborted),
# (ii) drifting-soft rate, (iii) per-call judge latency + invocation fraction
# (Cell B comes free from these runs — gateJudgeMs is now instrumented).
#
# Needs image >= 0.1.731 (the --workload + gateJudgeMs build); the v0.1.692 fleet
# predates it, so MINVER guards against running on a stale box.
#
# Cells: Sonnet 4.6 (production judge target) + Qwen3-235B (FPR-not-agent-specific).
# Arms: none (baseline utility) / intent-tracker (post-turn) / intent-tracker-enforced
# (per-call). Workload=legitimate, 10 tasks x 20 reps. Judge Sonnet 4.6 + B7.1.
#
# Usage: ./launch-pretooluse-cost-fpr.sh [--dry]
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
# 0.1.732 = the build with BOTH the runner --workload flag AND the t3e entrypoint
# plumbing (WORKLOAD -> --workload). 0.1.731 has the runner flag but not the
# entrypoint, so it would silently run the exfil workload — guard against it.
MINVER="0.1.732"
REPS="${REPS:-20}"
ARMS="none,intent-tracker,intent-tracker-enforced"
DRY="${1:-}"

# cell: bedt:model:region   (both eu-central-1; legitimate workload has no canary egress)
CELLS=(
  "11:claude-sonnet-4-6:eu-central-1"
  "12:qwen3-235b:eu-central-1"
)

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

launched=0; skipped=0
for cell in "${CELLS[@]}"; do
  IFS=: read n model region <<< "$cell"
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ -z "${v:-}" ]]; then echo "SKIP bedt$n ($model): unreachable / not up"; ((skipped++)); continue; fi
  if ! ver_ge "$MINVER" "$v"; then echo "SKIP bedt$n ($model): v$v < $MINVER (needs the --workload build) — re-run when redeployed"; ((skipped++)); continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; ((skipped++)); continue; fi

  rid_model="${model//[.:\/]/-}"
  RUNID="p15a-ptu-cost-${rid_model}-b${n}-sonnetjudge-v${MINVER}-${region}"

  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n  $model  workload=legitimate  arms=3  reps=$REPS  -> $RUNID"
    ((launched++)); continue
  fi

  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "{
    \"test\":\"t3e\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",
    \"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"converse\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\",
    \"WORKLOAD\":\"legitimate\",\"DEFENCES\":\"$ARMS\",
    \"REPETITIONS\":\"$REPS\",\"MAX_TURNS\":\"10\",
    \"JUDGE_MODEL\":\"eu.anthropic.claude-sonnet-4-6\",
    \"EMBED_MODEL\":\"eu.cohere.embed-v4:0\",\"JUDGE_PROMPT\":\"B7.1\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"
  echo " <- bedt$n $model workload=legitimate reps=$REPS arms=3"
  ((launched++))
done

echo
echo "launched=$launched skipped=$skipped"
echo "RUN_ID prefix: p15a-ptu-cost-* (S3: s3://cko-results/t3e/<RUN_ID>/)"
echo "FPR + per-call cost are in each cell's summary (fprCalls/fprRuns/judgeInvocationFraction/meanJudgeMs)."
