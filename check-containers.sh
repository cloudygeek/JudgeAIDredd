#!/usr/bin/env bash
set -euo pipefail

CONTAINERS="bedt1 bedt2 bedt3 bedt4 bedt5 bedt6 bedt7 bedt8 bedt9 bedt10"
BASE_DOMAIN="aisandbox.dev.ckotech.internal"

echo "| Runner | Version | Status | Progress | Detail |"
echo "|--------|---------|--------|----------|--------|"

for c in ${CONTAINERS}; do
  json=$(curl -s --max-time 5 "https://${c}.${BASE_DOMAIN}/status" 2>/dev/null) || json=""
  if [ -z "$json" ] || echo "$json" | grep -q '<html'; then
    echo "| ${c} | - | stopped | - | - |"
    continue
  fi

  parsed=$(echo "$json" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('version=-')
    print('status=error')
    print('progress=-')
    print('detail=bad JSON')
    sys.exit(0)
p = d.get('params') or {}
prog = d.get('progress', {})
version = d.get('version', '-')
status = d.get('status', '-')
test = p.get('test', '-')
completed = prog.get('completedCombinations', 0)
total = prog.get('totalCombinations', 0)
failed = prog.get('failedCombinations', 0)

parts = []
for k in ('config','models','effort','reps','matrix'):
    v = p.get(k)
    if v: parts.append(f'{k}={v}')
params = '  '.join(parts)

detail = ''
if status in ('running', 'done', 'failed'):
    detail = f'Test {test}: {params}'
    if failed: detail += f'  ({failed} failed)'

progress = f'{completed}/{total}' if total else '-'

print(f'version={version}')
print(f'status={status}')
print(f'progress={progress}')
print(f'detail={detail}')
" 2>/dev/null) || parsed=""

  if [ -z "$parsed" ]; then
    echo "| ${c} | - | error | - | parse failed |"
    continue
  fi

  version=$(echo "$parsed" | grep '^version=' | cut -d= -f2-)
  status=$(echo "$parsed" | grep '^status=' | cut -d= -f2-)
  progress=$(echo "$parsed" | grep '^progress=' | cut -d= -f2-)
  detail=$(echo "$parsed" | grep '^detail=' | cut -d= -f2-)

  echo "| ${c} | ${version:--} | ${status:--} | ${progress:--} | ${detail} |"
done
