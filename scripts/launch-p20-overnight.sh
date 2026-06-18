#!/usr/bin/env bash
# launch-p20-overnight.sh — P20 cross-vendor consensus panel, overnight.
#
# Fires the P20 adversarial-judge cells across bedt13 + bedt14. Each /run runs
# ONE model's full deck (12 cases × N reps) serially on a box, so we queue cells
# back-to-back PER BOX (wait for each to reach done/failed before firing the next
# — the entrypoint cleans /app/runs at the START of each run, so the prior cell's
# S3 push must complete first). The two boxes run concurrently.
#
# Panel (persona-neutral, N=20): kimi DROPPED (unparseable output → fail-closed,
# see p20/FINDINGS.md). Image MINVER 0.1.696 (the cache-point fix).
#
# Usage: ./scripts/launch-p20-overnight.sh [--dry]

set -uo pipefail

MINVER="0.1.696"
REPS="${REPS:-20}"
PROMPT="${PROMPT:-persona-neutral}"
DRY="${1:-}"
OPENAI_KEY="$(cat openapi.key 2>/dev/null || cat "$(git rev-parse --show-toplevel)/openapi.key" 2>/dev/null || echo "")"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# cell: model|region|effort|temp|backend|label  (| delimiter — model ids contain ':')
# temp/effort/backend may be empty.
# bedt13 — eu-central-1 panel
BEDT13_CELLS=(
  "eu.anthropic.claude-opus-4-8|eu-central-1|high||bedrock|opus-4-8"
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0|eu-central-1|high||bedrock|haiku-4-5"
  "qwen.qwen3-235b-a22b-2507-v1:0|eu-central-1|none||bedrock|qwen3-235b"
  "openai.gpt-oss-120b-1:0|eu-central-1|none||bedrock|gpt-oss-120b"
  "eu.amazon.nova-pro-v1:0|eu-central-1|none||bedrock|nova-pro"
)
# bedt14 — us-west-2 cross-vendor + eu temp sweep
BEDT14_CELLS=(
  "deepseek.v3.2|us-west-2|none||bedrock|deepseek-v3.2"
  "zai.glm-4.7|us-west-2|none||bedrock|glm-4.7"
  "openai.gpt-oss-120b-1:0|eu-central-1|none|0,0.5,1|bedrock|gpt-oss-120b-tempsweep"
)

box_url() { echo "https://bedt${1}.aisandbox.dev.ckotech.internal"; }

box_version() {
  curl -sk -m10 "$(box_url "$1")/status" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('version','0'))" 2>/dev/null || echo "0"
}
box_status() {
  curl -sk -m10 "$(box_url "$1")/status" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?"
}
ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

# Fire one cell, retrying /run on transient connection resets.
fire_cell() {
  local box="$1" cell="$2"
  IFS='|' read -r model region effort temp backend label <<< "$cell"
  local rid="p20-consensus-${label}-${region}-v${MINVER}-${TS}"

  # Build env JSON
  local env_json="{\"AWS_REGION\":\"$region\",\"JUDGE_MODEL\":\"$model\",\"JUDGE_BACKEND\":\"${backend:-bedrock}\",\"JUDGE_PROMPT\":\"$PROMPT\",\"JUDGE_EFFORT\":\"${effort:-none}\",\"REPETITIONS\":\"$REPS\",\"RUN_ID\":\"$rid\""
  [[ -n "$temp" ]] && env_json="$env_json,\"JUDGE_TEMPERATURE\":\"$temp\""
  [[ "${backend:-bedrock}" == "openai" ]] && env_json="$env_json,\"OPENAI_API_KEY\":\"$OPENAI_KEY\""
  env_json="$env_json}"

  if [[ "$DRY" == "--dry" ]]; then
    echo "  [bedt$box] WOULD fire: $label ($model, $region, effort=${effort:-none}, temp=${temp:-default}) rid=$rid"
    return 0
  fi

  # Fire with up to 3 retries on reset.
  local started="" attempt
  for attempt in 1 2 3; do
    local resp
    resp=$(curl -sk -m30 -X POST "$(box_url "$box")/run" -H "Content-Type: application/json" -d "{\"test\":\"p20\",\"runId\":\"$rid\",\"env\":$env_json}" 2>&1)
    if echo "$resp" | grep -q '"status":"running"'; then started=1; break; fi
    echo "  [bedt$box] $label fire attempt $attempt: ${resp:0:80}"
    sleep 6
  done
  if [[ -z "$started" ]]; then echo "  [bedt$box] $label FAILED to start after 3 attempts — skipping"; return 1; fi
  echo "  [bedt$box] started $label  (rid=$rid)"

  # Poll until done/failed (cap 90 min/cell).
  local i st
  for i in $(seq 1 540); do
    sleep 10
    st=$(box_status "$box")
    if [[ "$st" == "done" || "$st" == "failed" ]]; then
      echo "  [bedt$box] $label -> $st (after ~$((i*10))s)"
      return 0
    fi
  done
  echo "  [bedt$box] $label TIMEOUT after 90min (status=$st) — moving on"
  return 1
}

run_queue() {
  local box="$1"; shift
  local cells=("$@")
  local v; v=$(box_version "$box")
  if ! ver_ge "$MINVER" "$v"; then echo "[bedt$box] ABORT: v$v < MINVER $MINVER (redeploy first)"; return 1; fi
  echo "[bedt$box] v$v OK — queue of ${#cells[@]} cells"
  local c
  for c in "${cells[@]}"; do fire_cell "$box" "$c"; done
  echo "[bedt$box] QUEUE COMPLETE"
}

echo "=== P20 overnight launch (MINVER=$MINVER, REPS=$REPS, PROMPT=$PROMPT, TS=$TS) ==="
[[ "$DRY" == "--dry" ]] && echo "(dry run — no cells fired)"
[[ -z "$OPENAI_KEY" && "$DRY" != "--dry" ]] && echo "(note: openapi.key empty/missing — only matters for openai-backend cells; none in this plan)"

# Two box-queues concurrently.
run_queue 13 "${BEDT13_CELLS[@]}" &
P13=$!
run_queue 14 "${BEDT14_CELLS[@]}" &
P14=$!
wait $P13; wait $P14
echo "=== ALL QUEUES COMPLETE ($(date -u +%H:%M:%SZ)) ==="