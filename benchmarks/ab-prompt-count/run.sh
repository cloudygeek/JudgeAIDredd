#!/bin/bash
# A/B harness driver. Runs N×{baseline,dredd} via drive.mjs and parses each
# transcript into a CSV. The "test repo" is a fresh local clone of
# JudgeAIDredd held under $AB_ROOT/repo and reset between runs (git restore +
# git clean -fd, NOT rm -rf — so node_modules survives).
#
# Required env from the operator:
#   DREDD_API_KEY  — value of test.key (jaid_live_...)
# Optional:
#   AB_ROOT        — default /tmp/dredd-ab
#   REPEATS        — runs per variant (default 3)
#   DREDD_URL      — default the deployed sandbox
#   SOURCE_REPO    — default the repo containing this script's parent
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE_REPO="${SOURCE_REPO:-$(cd "$HERE/../.." && pwd)}"

AB_ROOT="${AB_ROOT:-/tmp/dredd-ab}"
AB_REPO="$AB_ROOT/repo"
AB_RESULTS="${AB_RESULTS:-$HERE/results}"
REPEATS="${REPEATS:-3}"
DREDD_URL="${DREDD_URL:-https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal}"
DREDD_API_KEY="${DREDD_API_KEY:?DREDD_API_KEY is required (cat test.key)}"

mkdir -p "$AB_ROOT" "$AB_RESULTS"

# ---------- prepare the test repo (once) ----------------------------------
if [ ! -d "$AB_REPO/.git" ]; then
  echo "[run] cloning $SOURCE_REPO -> $AB_REPO"
  git clone --quiet "$SOURCE_REPO" "$AB_REPO"
  ( cd "$AB_REPO" && npm install --silent --no-audit --no-fund )
fi

# Confirm Dredd reachable + interactive
HEALTH=$(curl -sk "$DREDD_URL/api/health")
echo "[run] dredd health: $HEALTH"
MODE=$(echo "$HEALTH" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).config?.mode??""))')
if [ "$MODE" != "interactive" ]; then
  echo "[run] WARNING: deployed Dredd CONFIG.mode=$MODE — driver will pass DREDD_MODE=interactive per session"
fi

# ---------- one_run helper ------------------------------------------------
one_run() {
  local variant="$1"
  local idx="$2"
  local stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local base="$AB_RESULTS/${variant}-${idx}-${stamp}"
  local jsonl="${base}.jsonl"
  local csv="${base}.csv"

  echo "[run] === $variant run $idx ==="

  # Fresh worktree state
  ( cd "$AB_REPO" && git restore . && git clean -fd >/dev/null )

  # We do NOT touch ~/.claude/projects/...; --no-session-persistence on the
  # driver means there's nothing to clean up there.

  VARIANT="$variant" \
  REPO="$AB_REPO" \
  OUT="$jsonl" \
  RUN_INDEX="$idx" \
  DREDD_URL="$DREDD_URL" \
  DREDD_API_KEY="$DREDD_API_KEY" \
  DREDD_MODE="interactive" \
  node "$HERE/drive.mjs" || echo "[run] driver exited non-zero"

  if [ -s "$jsonl" ]; then
    node "$HERE/parse.mjs" "$jsonl" --csv-out "$csv" --label "${variant}-${idx}"
  else
    echo "[run] empty transcript: $jsonl"
  fi
}

# ---------- run all variants ----------------------------------------------
for i in $(seq 1 "$REPEATS"); do
  one_run baseline "$i"
done
for i in $(seq 1 "$REPEATS"); do
  one_run dredd "$i"
done

# ---------- consolidated summary -------------------------------------------
SUMMARY="$AB_RESULTS/ab-results.csv"
{
  echo "variant,run,session_id,num_turns,duration_ms,tool_calls,ran_ok,prompted_or_denied,permission_denials_field,is_error,stop_reason"
  for f in "$AB_RESULTS"/*.summary.json; do
    [ -e "$f" ] || continue
    node -e '
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const m = s.label.match(/^(baseline|dredd)-(\d+)$/) || ["", "?", "?"];
      console.log([m[1], m[2], s.session_id, s.num_turns, s.duration_ms, s.tool_calls, s.ran_ok, s.prompted_or_denied, s.permission_denials_field, s.is_error, s.stop_reason].join(","));
    ' "$f"
  done
} > "$SUMMARY"

echo
echo "[run] consolidated results:"
cat "$SUMMARY"
echo
echo "[run] artefacts in $AB_RESULTS"
