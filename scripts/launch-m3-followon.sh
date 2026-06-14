#!/usr/bin/env bash
# M3 follow-on batch — harden the Mode4 sub-findings the MVP trio left at small-n
# (per results/mode4-2026-06-13-opus48-largeN/SUMMARY.md "Pending" + 14-06-2026.md).
# Core regression + gate claims are already n=50 (the MVP). These complete:
#   A3/B3  C4-SDK n=50      — "gate-free SDK reproduces the 90%" (was n=10)
#   C1/C2  flood-100 n=30   — flood-depth scaling (was 5/5)
#   D1     max-effort n=30  — effort-suppression P1 10/10->1/5 (was n=5)
#   E1/E2  gpt-5 / o3 n=20  — frontier controls, model-not-vendor (was n=10)
#
# Run-type interfaces (mode4 entrypoint env vars):
#   C4-SDK   : CONFIGS=C4  REPETITIONS=N      (SDK, parallel via RUNNER_CONCURRENCY)
#   C1-CLI   : CONFIGS=C1  CLI_BOUNDS=yes  CLI_REPETITIONS=N  (real claude binary, SERIAL/slow)
#   controls : BACKEND=openai  AGENT_MODELS=gpt-5|o3  (CONFIGS ignored, raw model+tools)
# PREREQUISITE: container v0.1.677+ (mode4 harness + vendored claude binary).
# Usage: ./launch-m3-followon.sh [--dry]
set -uo pipefail
KEY=$(cat ~/.claude/dredd/api-key)
OPENAI_KEY=$(cat openapi.key 2>/dev/null || cat "$(git rev-parse --show-toplevel)/openapi.key")
DREDD_URL="https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal"
MIN_VER="0.1.677"; DRY="${1:-}"

# bedt:cell:model:runtype:flood:reps:effort:backend
CELLS=(
  "3:A3:claude-opus-4-8:C4SDK:50:50::"
  "4:B3:claude-opus-4-7:C4SDK:50:50::"
  "5:C1f:claude-opus-4-8:C1CLI:100:30::"
  "6:C2f:claude-opus-4-7:C1CLI:100:30::"
  "7:D1:claude-opus-4-8:C1CLI:50:30:max:"
  "8:E1:gpt-5:OPENAI:50:20::openai"
  "9:E2:o3:OPENAI:50:20::openai"
)
ver_ge(){ [[ "$(printf '%s\n%s\n' "$1" "$2"|sort -V|head -1)" == "$1" ]]; }
for cell in "${CELLS[@]}"; do
  IFS=: read n tag model rt flood reps effort backend <<< "$cell"
  read v st < <(curl -sk -m5 "https://bedt$n.aisandbox.dev.ckotech.internal/status"|python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('version','0'),d.get('status'))" 2>/dev/null)
  if ! ver_ge "$MIN_VER" "$v"; then echo "SKIP bedt$n ($tag $model): v$v < $MIN_VER"; continue; fi
  if [[ "$st" == "running" ]]; then echo "SKIP bedt$n ($tag): busy"; continue; fi
  rid="${model//[.:\/]/-}"
  RUNID="mode4-m3fu-${tag}-${rid}-flood${flood}-$(echo $RANDOM)"
  # build env per run-type
  env_extra=""
  case "$rt" in
    C4SDK)  env_extra="\"CONFIGS\":\"C4\",\"REPETITIONS\":\"$reps\"";;
    C1CLI)  env_extra="\"CONFIGS\":\"C1\",\"CLI_BOUNDS\":\"yes\",\"CLI_REPETITIONS\":\"$reps\"";;
    OPENAI) env_extra="\"BACKEND\":\"openai\",\"CLI_REPETITIONS\":\"$reps\",\"OPENAI_API_KEY\":\"$OPENAI_KEY\"";;
  esac
  [[ -n "$effort" ]] && env_extra="$env_extra,\"EFFORT\":\"$effort\""
  region="eu-central-1"; awsregion="eu-west-2"; usebedrock="\"CLAUDE_CODE_USE_BEDROCK\":\"1\","
  [[ "$backend" == "openai" ]] && usebedrock=""
  if [[ "$DRY" == "--dry" ]]; then echo "WOULD launch bedt$n $tag $model $rt flood=$flood reps=$reps effort=${effort:-default}"; continue; fi
  curl -sk -m30 -X POST "https://bedt$n.aisandbox.dev.ckotech.internal/run" -H "Content-Type: application/json" -d "{
    \"test\":\"mode4\",\"runId\":\"$RUNID\",\"env\":{\"RUN_ID\":\"$RUNID\",\"AGENT_MODELS\":\"$model\",
    \"FLOOD_TURNS\":\"$flood\",\"AWS_REGION\":\"$awsregion\",$usebedrock$env_extra,
    \"DREDD_URL\":\"$DREDD_URL\",\"DREDD_API_KEY\":\"$KEY\"}}"
  echo " <- bedt$n $tag $model $rt flood=$flood reps=$reps effort=${effort:-default}"
done
