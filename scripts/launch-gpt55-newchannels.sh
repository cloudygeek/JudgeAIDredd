#!/usr/bin/env bash
# gpt-5.5 across the 5 ADDENDUM-14 channels (TEGRESS + P2-P5).
# gpt-5.5 runs via the OpenAI backend (executor-openai), which gained P1-P5
# parity in v0.1.649. Needs OPENAI_API_KEY (from openapi.key).
# PREREQUISITE: container on v0.1.649+ (the openai-parity build).
#
# Splits across 2 containers to parallelise (TEGRESS is N=80, P2-P5 is N=120):
#   arg1 = bedt number for TEGRESS, arg2 = bedt number for P2-P5.
# Usage: ./launch-gpt55-newchannels.sh <bedtA> <bedtB> [--dry]
set -uo pipefail
KEY=$(cat ~/.claude/dredd/api-key)
OPENAI_KEY=$(cat openapi.key 2>/dev/null || cat "$(git rev-parse --show-toplevel)/openapi.key")
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MIN_VER="0.1.649"
A="${1:?need bedt number for TEGRESS}"; B="${2:?need bedt number for P2-P5}"; DRY="${3:-}"
REGION="eu-central-1"; PREFIX="eu"   # gpt-5.5 via OpenAI API; region only matters for the Bedrock judge

launch() {
  local n="$1" techs="$2" tag="$3"
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if [[ "$(printf '%s\n%s\n' "$MIN_VER" "$v" | sort -V | head -1)" != "$MIN_VER" ]]; then echo "SKIP bedt$n: v$v < $MIN_VER (needs openai-parity build)"; return; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n: busy"; return; fi
  local RUNID="p15b-${tag}-gpt-5-5-sonnetjudge-v0.1.649-${REGION}"
  if [[ "$DRY" == "--dry" ]]; then echo "WOULD launch bedt$n gpt-5.5 [$techs]"; return; fi
  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" -H "Content-Type: application/json" -d "{
    \"test\":\"t5\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",\"AGENT_MODELS\":\"gpt-5.5\",\"AGENT_BACKEND\":\"openai\",
    \"AGENT_REGION\":\"$REGION\",\"AWS_REGION\":\"$REGION\",\"OPENAI_API_KEY\":\"$OPENAI_KEY\",
    \"TECHNIQUES\":\"$techs\",\"DEFENCES\":\"C4-baseline,C4-judge\",\"REPETITIONS\":\"10\",\"MAX_TURNS\":\"10\",
    \"JUDGE_MODEL\":\"$PREFIX.anthropic.claude-sonnet-4-6\",\"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"
  echo " <- bedt$n gpt-5.5 [$techs]"
}

launch "$A" "TEGRESS" "tegress"
launch "$B" "TMCPDESC,TDELAY,TEMIT,TSLOP" "p2345"
