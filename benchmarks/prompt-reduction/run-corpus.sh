#!/usr/bin/env bash
# Run the prompt-reduction harness across the corpus of traces.
# Each trace is run at N reps (default 10) and writes its own result JSON
# into results/corpus-<timestamp>/<trace-name>.json. After all traces
# complete, aggregate-corpus.ts produces a combined summary.
#
# Prereqs:
#   - Node 20+ and npx on PATH
#   - A Judge Dredd server reachable at $DREDD_URL (default http://localhost:3456)
#
# Usage:
#   ./run-corpus.sh            # default: all traces, N=10
#   ./run-corpus.sh 5          # N=5 instead
#   DREDD_URL=http://... ./run-corpus.sh
#
# Output directory is results/corpus-<iso8601>/ with per-trace JSONs plus a
# summary.json produced by aggregate-corpus.ts.

set -euo pipefail

REPS="${1:-10}"
DREDD_URL="${DREDD_URL:-http://localhost:3456}"
RUN_TIMESTAMP="$(date -u +'%Y-%m-%dT%H-%M-%SZ')"
OUT_DIR="results/corpus-${RUN_TIMESTAMP}"
TRACES_DIR="traces"

cd "$(dirname "$0")"

if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx not on PATH (install Node 20+)" >&2
  exit 2
fi

# Verify server is reachable before burning time on runs.
if ! curl -sf "${DREDD_URL}/health" >/dev/null 2>&1; then
  echo "error: Judge Dredd server unreachable at ${DREDD_URL}" >&2
  echo "       start one with: npm run server:bedrock:interactive" >&2
  exit 3
fi

mkdir -p "${OUT_DIR}"

echo "Corpus run"
echo "  Dredd URL:  ${DREDD_URL}"
echo "  Reps:       ${REPS}"
echo "  Output dir: ${OUT_DIR}"
echo

TRACES=("${TRACES_DIR}"/*.json)
echo "Traces to run: ${#TRACES[@]}"
for t in "${TRACES[@]}"; do
  echo "  - $(basename "$t")"
done
echo

START_TS=$(date -u +%s)

for trace in "${TRACES[@]}"; do
  name=$(basename "${trace}" .json)
  out="${OUT_DIR}/${name}.json"
  echo "=== ${name} ==="
  npx tsx measure-prompts.ts \
    --trace "${trace}" \
    --dredd-url "${DREDD_URL}" \
    --reps "${REPS}" \
    --out "${out}"
  echo
done

END_TS=$(date -u +%s)
DURATION=$((END_TS - START_TS))

echo "All traces complete."
echo "  Wall-clock: ${DURATION}s"
echo

echo "Aggregating corpus results..."
npx tsx aggregate-corpus.ts "${OUT_DIR}" | tee "${OUT_DIR}/summary.txt"
echo
echo "Summary written to ${OUT_DIR}/summary.json and ${OUT_DIR}/summary.txt"
