#!/usr/bin/env bash
# launch-p20-benign.sh — P20 benign deck (false-block / availability half).
#
# Complements launch-p20-overnight.sh (the adv/recall half, already banked). Runs
# the SAME 8-vendor panel over the benign deck (DECK=benign: 17 InjecAgent
# user_cases + 15 security-adjacent) so false-block / availability lands on the
# same judge-eval axis as the recall numbers → F1 / MCC computable per model.
#
# Same harness as the overnight launcher: one /run per model (32 benign cases ×
# N reps), queued back-to-back PER BOX (wait for each S3 push before the next),
# the two boxes concurrent.
#
# Differences from the adv wave:
#   - DECK=benign in every cell.
#   - kimi INCLUDED — the 2048-token reasoning floor (0.1.704+) fixed its
#     truncation, and benign cases are short, so it parses cleanly now.
#   - gpt-4o INCLUDED (openai backend, key spliced) — it's a panel member.
#   - MINVER 0.1.708 (the --deck/benign-deck build). Old boxes SKIP.
#
# Usage: ./scripts/launch-p20-benign.sh [--dry]

set -uo pipefail

MINVER="0.1.708"
REPS="${REPS:-20}"
PROMPT="${PROMPT:-persona-neutral}"
DECK="benign"
DRY="${1:-}"
OPENAI_KEY="$(cat openapi.key 2>/dev/null || cat "$(git rev-parse --show-toplevel)/openapi.key" 2>/dev/null || echo "")"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# cell: model|region|effort|backend|label  (| delimiter — model ids contain ':')
# No temp column here — the benign half doesn't sweep temperature (that was the
# adv-side P0-g study); every cell uses the backend's effort-derived default.
# bedt13 — eu-central-1 panel (5 cells)
BEDT13_CELLS=(
  "eu.anthropic.claude-opus-4-8|eu-central-1|high|bedrock|opus-4-8"
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0|eu-central-1|high|bedrock|haiku-4-5"
  "qwen.qwen3-235b-a22b-2507-v1:0|eu-central-1|none|bedrock|qwen3-235b"
  "openai.gpt-oss-120b-1:0|eu-central-1|none|bedrock|gpt-oss-120b"
  "eu.amazon.nova-pro-v1:0|eu-central-1|none|bedrock|nova-pro"
)
# bedt14 — us-west-2 cross-vendor + gpt-4o (openai) (4 cells)
BEDT14_CELLS=(
  "deepseek.v3.2|us-west-2|none|bedrock|deepseek-v3.2"
  "zai.glm-4.7|us-west-2|none|bedrock|glm-4.7"
  "moonshot.kimi-k2-thinking|us-west-2|none|bedrock|kimi-k2-thinking"
  "gpt-4o|eu-central-1|none|openai|gpt-4o"
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

fire_cell() {
  local box="$1" cell="$2"
  IFS='|' read -r model region effort backend label <<< "$cell"
  local rid="p20-benign-${label}-${region}-v${MINVER}-${TS}"

  local env_json="{\"AWS_REGION\":\"$region\",\"JUDGE_MODEL\":\"$model\",\"JUDGE_BACKEND\":\"${backend:-bedrock}\",\"JUDGE_PROMPT\":\"$PROMPT\",\"JUDGE_EFFORT\":\"${effort:-none}\",\"REPETITIONS\":\"$REPS\",\"DECK\":\"$DECK\",\"RUN_ID\":\"$rid\""
  [[ "${backend:-bedrock}" == "openai" ]] && env_json="$env_json,\"OPENAI_API_KEY\":\"$OPENAI_KEY\""
  env_json="$env_json}"

  if [[ "$DRY" == "--dry" ]]; then
    echo "  [bedt$box] WOULD fire: $label ($model, $region, ${backend:-bedrock}, effort=${effort:-none}, deck=$DECK) rid=$rid"
    return 0
  fi

  local started="" attempt resp
  for attempt in 1 2 3; do
    resp=$(curl -sk -m30 -X POST "$(box_url "$box")/run" -H "Content-Type: application/json" -d "{\"test\":\"p20\",\"runId\":\"$rid\",\"env\":$env_json}" 2>&1)
    if echo "$resp" | grep -q '"status":"running"'; then started=1; break; fi
    echo "  [bedt$box] $label fire attempt $attempt: ${resp:0:80}"
    sleep 6
  done
  if [[ -z "$started" ]]; then echo "  [bedt$box] $label FAILED to start after 3 attempts — skipping"; return 1; fi
  echo "  [bedt$box] started $label  (rid=$rid)"

  # Poll until done/failed (cap 90 min/cell; kimi is the slow one).
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
  if ! ver_ge "$MINVER" "$v"; then echo "[bedt$box] ABORT: v$v < MINVER $MINVER (redeploy 0.1.708 first)"; return 1; fi
  echo "[bedt$box] v$v OK — benign queue of ${#cells[@]} cells"
  local c
  for c in "${cells[@]}"; do fire_cell "$box" "$c"; done
  echo "[bedt$box] QUEUE COMPLETE"
}

echo "=== P20 BENIGN launch (DECK=$DECK, MINVER=$MINVER, REPS=$REPS, PROMPT=$PROMPT, TS=$TS) ==="
[[ "$DRY" == "--dry" ]] && echo "(dry run — no cells fired)"
[[ -z "$OPENAI_KEY" && "$DRY" != "--dry" ]] && echo "WARN: openapi.key empty/missing — the gpt-4o cell will fail-soft. Fix before firing."

run_queue 13 "${BEDT13_CELLS[@]}" &
P13=$!
run_queue 14 "${BEDT14_CELLS[@]}" &
P14=$!
wait $P13; wait $P14
echo "=== ALL BENIGN QUEUES COMPLETE ($(date -u +%H:%M:%SZ)) ==="
echo "Results: s3://cko-results/p20/p20-benign-*-${TS}/  (groundTruth.benign.falseBlockRate per cell)"