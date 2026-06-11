#!/usr/bin/env bash
# ADDENDUM 15 — FINAL WAVE: bring the crack vectors to publication N + complete the frontier.
#
# What this fires (one cell per container, all parallel):
#   A. Crack top-ups (converse) — TSTAGE,TSLOP,TEMIT, reps=30 → pools with existing to
#      TSTAGE ~80, TSLOP ~40, TEMIT ~80. Frontier (opus-4-8/4-7, sonnet-4-6) + deepseek/qwen-coder.
#   B. gpt-5.5 TSTAGE (openai backend, needs v0.1.649) — the one missing crack vector for gpt-5.5.
#   C. fable-5 on all 5 crack vectors (converse) — split across 2 boxes: TEGRESS | TSTAGE,TSLOP,TEMIT,TMCPDESC.
#
# TMCPDESC/TDELAY top-ups intentionally SKIPPED — both floor (0) on frontier, no value expanding.
# DNS post-fix already satisfied (all TEGRESS cells are v0.1.639+).
#
# Distinct RUN_IDs (…-a15-…) so prefixes don't collide; pull routes by filename technique
# into the existing tstage/ p2345/ tegress/ dirs (analysis pools by model+scenario+arm).
#
# Usage: ./launch-addendum15-final.sh [--dry]
set -uo pipefail
KEY=$(cat ~/.claude/dredd/api-key)
OPENAI_KEY=$(cat openapi.key 2>/dev/null || cat "$(git rev-parse --show-toplevel)/openapi.key")
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
DRY="${1:-}"

# cell: bedt:model:region:prefix:backend:techniques:reps:minver:tag
CELLS=(
  # A — crack top-ups (converse), one model per box
  "9:claude-opus-4-8:eu-central-1:eu:converse:TSTAGE,TSLOP,TEMIT:30:0.1.639:crack"
  "8:claude-opus-4-7:eu-central-1:eu:converse:TSTAGE,TSLOP,TEMIT:30:0.1.639:crack"
  "6:claude-sonnet-4-6:eu-central-1:eu:converse:TSTAGE,TSLOP,TEMIT:30:0.1.639:crack"
  "14:deepseek-v3.2:us-west-2:us:converse:TSTAGE,TSLOP,TEMIT:30:0.1.639:crack"
  "15:qwen3-coder-480b:us-west-2:us:converse:TSTAGE,TSLOP,TEMIT:30:0.1.639:crack"
  # B — gpt-5.5 missing crack vector (openai backend, needs .649)
  "3:gpt-5.5:eu-central-1:eu:openai:TSTAGE:20:0.1.649:gpt55tstage"
  # C — fable-5 on the 5 crack vectors (converse), split across 2 boxes
  "5:eu.anthropic.claude-fable-5:eu-central-1:eu:converse:TEGRESS:20:0.1.639:fableegress"
  "7:eu.anthropic.claude-fable-5:eu-central-1:eu:converse:TSTAGE,TSLOP,TEMIT,TMCPDESC:20:0.1.639:fablecrack"
)

ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

for cell in "${CELLS[@]}"; do
  IFS=: read n model region prefix backend techs reps minver tag <<< "$cell"
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if ! ver_ge "$minver" "$v"; then echo "SKIP bedt$n ($model): v$v < $minver"; continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($model): busy"; continue; fi
  # sanitize model for RUN_ID
  rid_model="${model//[.:\/]/-}"
  RUNID="p15b-a15-${tag}-${rid_model}-sonnetjudge-v0.1.653-${region}"
  if [[ "$DRY" == "--dry" ]]; then echo "WOULD launch bedt$n $model [$techs] reps=$reps backend=$backend"; continue; fi
  # build env JSON (add OPENAI_API_KEY only for openai backend)
  extra=""
  [[ "$backend" == "openai" ]] && extra=",\"OPENAI_API_KEY\":\"$OPENAI_KEY\""
  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" -H "Content-Type: application/json" -d "{
    \"test\":\"t5\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",\"AGENT_MODELS\":\"$model\",\"AGENT_BACKEND\":\"$backend\",
    \"AGENT_REGION\":\"$region\",\"AWS_REGION\":\"$region\"$extra,\"TECHNIQUES\":\"$techs\",\"DEFENCES\":\"C4-baseline,C4-judge\",
    \"REPETITIONS\":\"$reps\",\"MAX_TURNS\":\"10\",\"JUDGE_MODEL\":\"$prefix.anthropic.claude-sonnet-4-6\",
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"; echo " <- bedt$n $model [$techs] reps=$reps"
done
