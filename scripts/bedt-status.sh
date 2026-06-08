#!/usr/bin/env bash
# bedt-status.sh — sweep all bedt containers and report version + status + cell.
#
# Reads /status from each https://bedt<N>.aisandbox.dev.ckotech.internal
# in parallel and renders one line per container:
#
#   bedtN  v=A.B.C  status=running|done|idle|failed  model=…  tech=…  elapsed=…m  exit=…  runId=…
#
# Usage:
#   bash scripts/bedt-status.sh                       # default: 3..17
#   bash scripts/bedt-status.sh 3 4 5                 # explicit subset
#   BEDT_NUMBERS="3 4 6 9" bash scripts/bedt-status.sh
#   BEDT_TIMEOUT=8 bash scripts/bedt-status.sh
#
# Output is sorted in numeric container order so consecutive runs are easy
# to diff; "free" containers (status=done | idle | failed) are flagged with
# a leading marker so you can grep them.

set -uo pipefail

NUMBERS=( "${@:-}" )
if [[ -z "${NUMBERS[*]:-}" ]]; then
  if [[ -n "${BEDT_NUMBERS:-}" ]]; then
    read -ra NUMBERS <<< "${BEDT_NUMBERS}"
  else
    NUMBERS=( 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 )
  fi
fi
TIMEOUT="${BEDT_TIMEOUT:-5}"

TMPDIR_RUN="$(mktemp -d -t bedt-status-XXXXXX)"
trap 'rm -rf "${TMPDIR_RUN}"' EXIT

probe() {
  local n=$1
  local url="https://bedt${n}.aisandbox.dev.ckotech.internal/status"
  local body code
  code=$(curl -sk -m "${TIMEOUT}" -o "${TMPDIR_RUN}/${n}.json" \
                -w "%{http_code}" "${url}" 2>/dev/null || echo "000")
  echo "${code}" > "${TMPDIR_RUN}/${n}.code"
}

# Probe all containers in parallel; wait for the lot to finish.
for n in "${NUMBERS[@]}"; do probe "${n}" & done
wait

# Render via a single python pass — formatting + elapsed math in one place.
python3 - "${TMPDIR_RUN}" "${NUMBERS[@]}" <<'PY'
import sys, os, json, datetime

tmpdir = sys.argv[1]
numbers = sys.argv[2:]
now = datetime.datetime.now(datetime.timezone.utc)

def age(ts):
    if not ts: return "?"
    try:
        t = datetime.datetime.fromisoformat(ts.replace("Z","+00:00"))
        return f"{int((now - t).total_seconds() // 60)}m"
    except Exception:
        return "?"

free_states = {"done", "idle", "failed"}

print(f"{'container':<8} {'version':<10} {'status':<10} {'model':<22} {'tech':<6} {'elapsed':>8} {'exit':>5}  runId")
print("-" * 110)
free_count = 0
for n in numbers:
    code_path = os.path.join(tmpdir, f"{n}.code")
    json_path = os.path.join(tmpdir, f"{n}.json")
    code = open(code_path).read().strip() if os.path.exists(code_path) else "?"
    if code != "200" or not os.path.exists(json_path):
        print(f"bedt{n:<4} HTTP={code}")
        continue
    try:
        d = json.load(open(json_path))
    except Exception as e:
        print(f"bedt{n:<4} parse-error: {e}")
        continue
    v = d.get("version", "?")
    st = d.get("status", "?")
    env = (d.get("params") or {}).get("env") or {}
    mod = env.get("TEST22_MODELS", "?")[:22]
    tec = env.get("TEST22_TECHNIQUES", "?")[:6]
    rid = env.get("TEST22_RUN_ID") or env.get("RUN_ID") or d.get("runId", "?")
    started = d.get("startedAt")
    finished = d.get("finishedAt")
    ec = d.get("exitCode")
    elapsed = age(started) if not finished else age(started)
    marker = "*" if st in free_states else " "
    if st in free_states: free_count += 1
    ec_disp = "—" if ec is None else str(ec)
    print(f"{marker}bedt{n:<4} v={v:<8} {st:<10} {mod:<22} {tec:<6} {elapsed:>8} {ec_disp:>5}  {rid}")

print("-" * 110)
print(f"  legend: leading * marks free containers (status in {sorted(free_states)})")
print(f"  free: {free_count}/{len(numbers)}")
PY
