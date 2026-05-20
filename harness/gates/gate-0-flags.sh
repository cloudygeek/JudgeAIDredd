#!/usr/bin/env bash
# GATE-0 — flag-pin and trust-mode declaration.
#
# Refuses to launch a campaign unless every Dredd tunable that affects
# behaviour is set explicitly. Implicit defaults make campaigns
# unreplayable across versions; this gate forces an explicit answer.
#
# Output:
#   - one line per tunable to stdout
#   - JSON object suitable for splicing into metadata.json (--json)
#
# Exit:
#   0 — every required tunable is set to a value in its legal set
#   1 — at least one required tunable is unset or out of set
#
# Usage:
#   harness/gates/gate-0-flags.sh         # text report
#   harness/gates/gate-0-flags.sh --json  # JSON for metadata.json
set -euo pipefail

JSON_MODE=0
if [ "${1:-}" = "--json" ]; then
  JSON_MODE=1
fi

# Spec rows: var '@' legal-set-regex-or-empty '@' required?
# '@' is unused by both regex syntax and shell var names, and is not
# whitespace (so empty fields don't collapse during `read`).
# Keep this list aligned with REP-3 in TEST_REQUIREMENTS.md.
declare -a SPEC=(
  'MODE@^(autonomous|interactive|learn)$@1'
  'BACKEND@^(bedrock|ollama)$@1'
  'JUDGE_MODEL@@1'
  'EMBEDDING_MODEL@@1'
  'HARDENED@^(B7|B7\.1|B7\.1-office|standard)$@1'
  'STORE_BACKEND@^(memory|dynamo)$@1'
  'DREDD_USER_PERMISSIONS_ENABLED@^(true|false)$@1'
  'DREDD_PATTERN_LEARNING_ENABLED@^(true|false)$@1'
  'DREDD_PATTERN_LEARNING_HARD_ENABLED@^(true|false)$@1'
  'DREDD_MANAGED_ALLOW_SCOPE@^(off|conservative)$@1'
)

failures=0
declare -a OUT_KEYS=()
declare -a OUT_VALS=()
declare -a OUT_OK=()

for spec in "${SPEC[@]}"; do
  IFS='@' read -r var rx required <<< "$spec"
  val="${!var-}"
  if [ -z "$val" ]; then
    if [ "$required" = "1" ]; then
      [ "$JSON_MODE" = "0" ] && printf "FAIL  %-40s (unset)\n" "$var" >&2
      failures=$(( failures + 1 ))
      OUT_KEYS+=("$var"); OUT_VALS+=("null"); OUT_OK+=("false")
      continue
    fi
    [ "$JSON_MODE" = "0" ] && printf "skip  %-40s (unset, optional)\n" "$var"
    OUT_KEYS+=("$var"); OUT_VALS+=("null"); OUT_OK+=("true")
    continue
  fi
  if [ -n "$rx" ] && ! [[ "$val" =~ $rx ]]; then
    [ "$JSON_MODE" = "0" ] && printf "FAIL  %-40s = %-30s (not in legal set: /%s/)\n" "$var" "$val" "$rx" >&2
    failures=$(( failures + 1 ))
    OUT_KEYS+=("$var"); OUT_VALS+=("\"$val\""); OUT_OK+=("false")
    continue
  fi
  [ "$JSON_MODE" = "0" ] && printf "ok    %-40s = %s\n" "$var" "$val"
  OUT_KEYS+=("$var"); OUT_VALS+=("\"$val\""); OUT_OK+=("true")
done

if [ "$JSON_MODE" = "1" ]; then
  printf '{'
  for i in "${!OUT_KEYS[@]}"; do
    [ "$i" -gt 0 ] && printf ','
    printf '"%s":%s' "${OUT_KEYS[$i]}" "${OUT_VALS[$i]}"
  done
  printf ',"_pass":%s' "$([ $failures -eq 0 ] && echo true || echo false)"
  printf '}\n'
fi

if [ $failures -gt 0 ]; then
  [ "$JSON_MODE" = "0" ] && echo >&2
  [ "$JSON_MODE" = "0" ] && echo "GATE-0 FAIL: $failures unset or out-of-set tunables." >&2
  [ "$JSON_MODE" = "0" ] && echo "Set them explicitly before launching the campaign." >&2
  exit 1
fi

[ "$JSON_MODE" = "0" ] && echo
[ "$JSON_MODE" = "0" ] && echo "GATE-0 PASS"
exit 0
