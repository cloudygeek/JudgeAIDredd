#!/usr/bin/env bash
# launch-pretooluse-t5-multiagent.sh — full T5 multi-agent front under the
# enforcing PreToolUse gate (tab:t5-perscenario).
#
# Implements docs/test-request-t5-enforced-multiagent-2026-06-23.md: re-runs the
# 12-agent T5 per-scenario table's defended arm at the PreToolUse call point
# (the paper currently ships post-turn data there). Qwen3-235B already done
# (enforced 0/60); Anthropic floor omitted (0/60 baseline). gpt-5.1 EXCLUDED
# (openai — held out per operator). Leaves 11 agents: 9 converse + 2 Gemini (vertex).
#
# Runner: runner-p14.ts via test:"t5" (it has the C4-judge-enforced[-stage1] arms).
# Protocol matches the qwen3-235b T5 enforced cell: Sonnet 4.6 judge + B7.1 + Cohere
# embed-v4, T5.1-3 x20 = 60/arm. Arms: C4-judge-enforced + C4-judge-enforced-stage1
# (baseline is call-point-independent; carry the existing bad_run baselines over).
#
# Vertex (gemini) uses the GCP/WIF env already present on the boxes; the t5
# entrypoint passes GCP_PROJECT/VERTEX_REGION/GCP_WIF_CONFIG_JSON through. Gemini 3
# is global-location only -> VERTEX_REGION=global.
#
# Image >= 0.1.692 (the enforced-arm build). bedt15/16 (0.1.639) excluded by MINVER.
#
# Usage: ./launch-pretooluse-t5-multiagent.sh [--dry]
set -uo pipefail

KEY=$(cat ~/.claude/dredd/api-key)
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MINVER="0.1.692"
REPS="${REPS:-20}"
ARMS="C4-judge-enforced,C4-judge-enforced-stage1"
DRY="${1:-}"
# WIF credential config for the vertex (gemini) cells. external_account config
# with an environment-based credential_source (reads the box's AWS IMDS token,
# exchanges via STS, impersonates the test-vertex SA). Passed inline as
# GCP_WIF_CONFIG_JSON. NOT committed (gitignored). The v0.1.692 boxes don't have
# it baked in, so it must come through the /run env.
WIF_FILE="${WIF_FILE:-$(cd "$(dirname "$0")/.." && pwd)/gcp-wif.json}"

# cell: bedt:model:region:backend     (gemini=vertex; rest=converse)
# regions per executor map: us-east-1 (coder-next), us-west-2 (glm-4.7/glm-5/
# deepseek-v3.1/qwen3-coder-480b), eu-central-1 (rest), global (gemini vertex).
CELLS=(
  "3:gpt-oss-120b:eu-central-1:converse"
  "4:devstral-2-123b:eu-central-1:converse"
  "5:nemotron-super-3-120b:eu-central-1:converse"
  "6:minimax-m2.5:eu-central-1:converse"
  "7:glm-4.7:us-west-2:converse"
  "8:glm-5:us-west-2:converse"
  "9:deepseek-v3.1:us-west-2:converse"
  "10:qwen3-coder-480b:us-west-2:converse"
  "13:qwen3-coder-next:us-east-1:converse"
  "11:gemini-3.1-pro-preview:global:vertex"
  "12:gemini-3.5-flash:global:vertex"
)

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }
prefix_for() { case "$1" in us-*) echo us;; *) echo eu;; esac; }

launched=0; skipped=0
for cell in "${CELLS[@]}"; do
  IFS=: read n model region backend <<< "$cell"
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ -z "${v:-}" ]]; then echo "SKIP bedt$n ($model): unreachable"; ((skipped++)); continue; fi
  if ! ver_ge "$MINVER" "$v"; then echo "SKIP bedt$n ($model): v$v < $MINVER"; ((skipped++)); continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; ((skipped++)); continue; fi

  rid_model="${model//[.:\/]/-}"
  # Judge/embed prefix follows the Bedrock region; for vertex cells the judge
  # still runs on Bedrock in eu-central-1, so AWS_REGION=eu-central-1 there.
  if [[ "$backend" == "vertex" ]]; then awsr="eu-central-1"; else awsr="$region"; fi
  prefix=$(prefix_for "$awsr")
  RUNID="p15a-ptu-t5-multiagent-${rid_model}-b${n}-sonnetjudge-v${MINVER}-${region}"

  # Vertex (gemini) cells need the GCP env: region=global, the WIF-target project
  # (v0.1.692 executor lacks the code-level default), and the inline WIF config
  # (boxes don't have it baked in). Read the WIF file at launch time for vertex cells.
  WIF_JSON=""
  if [[ "$backend" == "vertex" ]]; then
    if [[ ! -f "$WIF_FILE" ]]; then
      echo "SKIP bedt$n ($model): vertex cell but WIF file not found at $WIF_FILE"; ((skipped++)); continue
    fi
    WIF_JSON=$(python3 -c "import json,sys;print(json.dumps(json.load(open('$WIF_FILE')),separators=(',',':')))")
  fi

  if [[ "$DRY" == "--dry" ]]; then
    echo "WOULD launch bedt$n  $model  T5.1-3  arms=2  reps=$REPS  backend=$backend  region=$region (judge ${prefix}. @ $awsr)$([[ "$backend" == vertex ]] && echo "  +WIF(${#WIF_JSON}c)")  -> $RUNID"
    ((launched++)); continue
  fi

  # Build the /run body with python so the embedded WIF JSON is escaped correctly.
  BODY=$(RUNID="$RUNID" MODEL="$model" BACKEND="$backend" REGION="$region" AWSR="$awsr" \
    PREFIX="$prefix" ARMS="$ARMS" REPS="$REPS" DREDD_URL="$DREDD_URL" KEY="$KEY" \
    WIF_JSON="$WIF_JSON" GCP_PROJECT="${GCP_PROJECT:-sys-66937732661944501347517615}" \
    python3 -c '
import os, json
env = {
  "RUN_ID": os.environ["RUNID"],
  "AGENT_MODELS": os.environ["MODEL"], "AGENT_BACKEND": os.environ["BACKEND"],
  "AGENT_REGION": os.environ["REGION"], "AWS_REGION": os.environ["AWSR"],
  "TECHNIQUES": "T5", "DEFENCES": os.environ["ARMS"],
  "REPETITIONS": os.environ["REPS"], "MAX_TURNS": "10",
  "JUDGE_MODEL": os.environ["PREFIX"] + ".anthropic.claude-sonnet-4-6",
  "EMBED_MODEL": os.environ["PREFIX"] + ".cohere.embed-v4:0", "JUDGE_PROMPT": "B7.1",
  "DREDD_URL": os.environ["DREDD_URL"], "DREDD_API_KEY": os.environ["KEY"],
}
if os.environ["BACKEND"] == "vertex":
    env["VERTEX_REGION"] = "global"
    env["GCP_PROJECT"] = os.environ["GCP_PROJECT"]
    env["GCP_WIF_CONFIG_JSON"] = os.environ["WIF_JSON"]
print(json.dumps({"test": "t5", "runId": os.environ["RUNID"], "env": env}))
')
  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" \
    -H "Content-Type: application/json" -d "$BODY"
  echo " <- bedt$n $model T5.1-3 reps=$REPS arms=2 backend=$backend $region"
  ((launched++))
done

echo
echo "launched=$launched skipped=$skipped (of ${#CELLS[@]} cells; gpt-5.1 held out)"
echo "RUN_ID prefix: p15a-ptu-t5-multiagent-* (S3: s3://cko-results/t5/<RUN_ID>/)"
