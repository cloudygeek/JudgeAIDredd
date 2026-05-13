#!/bin/bash
# =============================================================================
# dredd-cleanup.sh — manual recovery for Phase 7 managed-allow rules.
#
# Strips Dredd-managed allow rules out of a project's
# .claude/settings.local.json and deletes the matching sidecars under
# $DREDD_MANAGED_DIR. Refcount-safe — when multiple sessions share a
# project, only the targeted session's sidecar is removed; the rules
# stay until the last managing sidecar is gone (same semantics as the
# automatic SessionEnd / sweep paths in dredd-hook.sh).
#
# Useful when:
#   - Debugging unexpected entries in settings.local.json
#   - Recovering after Dredd is uninstalled or replaced
#   - Triaging a project where rules have crept in unexpectedly
#
# Reuses the Phase 7 primitives in dredd-managed-allow.sh.
# =============================================================================

print_usage() {
  cat <<'EOF'
Usage: dredd-cleanup.sh [options]

Options:
  --project <path>   Clean up THIS project's sidecars + settings.local.json.
                     Defaults to the current working directory.
  --all              Clean up every project that has any Dredd-managed
                     sidecar under $DREDD_MANAGED_DIR.
  --dry-run          Print what would change without modifying any file.
  --yes              Skip the interactive confirmation prompt
                     (also implied when stdin is not a terminal).
  --quiet            Suppress non-error output.
  -h, --help         Show this help.

Environment:
  DREDD_MANAGED_DIR  Sidecar directory. Defaults to
                     $HOME/.claude/dredd/managed.
EOF
}

PROJECT=""
ALL=0
DRY=0
YES=0
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --project)
      [ $# -lt 2 ] && { echo "--project requires a path" >&2; exit 2; }
      PROJECT="$2"; shift 2;;
    --all)      ALL=1;    shift;;
    --dry-run)  DRY=1;    shift;;
    --yes)      YES=1;    shift;;
    --quiet)    QUIET=1;  shift;;
    -h|--help)  print_usage; exit 0;;
    --)         shift; break;;
    -*)         echo "unknown flag: $1" >&2; print_usage >&2; exit 2;;
    *)          echo "unexpected argument: $1" >&2; print_usage >&2; exit 2;;
  esac
done

# Source the primitives. Sibling file to this script.
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]:-$0}")/dredd-managed-allow.sh"

say()  { [ "$QUIET" = "1" ] && return; printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }

# Collect candidate sidecars for cleanup.
TARGETS=()
if [ "$ALL" = "1" ]; then
  if [ -d "$DREDD_MANAGED_DIR" ]; then
    for f in "$DREDD_MANAGED_DIR"/*.json; do
      [ -e "$f" ] || continue
      TARGETS+=("$f")
    done
  fi
else
  PROJECT="${PROJECT:-$PWD}"
  # Resolve to an absolute path so the hash matches what dredd-hook.sh wrote.
  if [ -d "$PROJECT" ]; then
    PROJECT=$(cd "$PROJECT" && pwd)
  fi
  PROJ_HASH=$(_dredd_project_hash "$PROJECT")
  if [ -d "$DREDD_MANAGED_DIR" ]; then
    for f in "$DREDD_MANAGED_DIR/${PROJ_HASH}--"*.json; do
      [ -e "$f" ] || continue
      TARGETS+=("$f")
    done
  fi
fi

if [ ${#TARGETS[@]} -eq 0 ]; then
  if [ "$ALL" = "1" ]; then
    say "No sidecars found under $DREDD_MANAGED_DIR — nothing to do."
  else
    say "No Dredd-managed sidecars found for project: $PROJECT"
  fi
  exit 0
fi

# Summary phase.
say "Targeting ${#TARGETS[@]} sidecar(s):"
for f in "${TARGETS[@]}"; do
  if dredd_sidecar_read "$f"; then
    sid=$(jq -r '.sessionId // ""' "$f" 2>/dev/null)
    say "  - $(basename "$f")"
    say "      project: ${SIDECAR_PROJECT_ROOT:-(unknown)}"
    say "      session: ${sid:-(unknown)}"
    say "      scope:   ${SIDECAR_SCOPE:-(unknown)}"
    say "      rules:   ${SIDECAR_RULES}"
  else
    say "  - $(basename "$f") (unparseable — will be deleted)"
  fi
done

if [ "$DRY" = "1" ]; then
  say
  say "(dry-run; no changes made)"
  exit 0
fi

# Interactive confirmation. Skipped when --yes, or when stdin is not a TTY
# (pipelines / CI shouldn't block on a prompt that nobody will answer).
if [ "$YES" = "0" ] && [ -t 0 ]; then
  printf 'Proceed? [y/N] '
  read -r ANS
  case "$ANS" in
    y|Y|yes|YES|Yes) ;;
    *) say "Aborted."; exit 0;;
  esac
fi

REMOVED=0
SKIPPED=0
for f in "${TARGETS[@]}"; do
  if dredd_sidecar_read "$f"; then
    pr="$SIDECAR_PROJECT_ROOT"
    rules="$SIDECAR_RULES"
    sid=$(jq -r '.sessionId // ""' "$f" 2>/dev/null)
    if [ -n "$pr" ] && [ "$rules" != "[]" ]; then
      if dredd_project_has_other_sidecars "$pr" "$sid"; then
        say "  skip rule strip on $pr (other sidecars still active)"
        _dredd_managed_log "$pr" "$sid" "manual-cleanup-skip-others-active" "$rules"
        SKIPPED=$((SKIPPED+1))
      else
        if dredd_settings_remove_rules "$pr" "$rules" 2>/dev/null; then
          say "  stripped managed rules from $pr/.claude/settings.local.json"
        else
          warn "  WARN: failed to strip rules from $pr/.claude/settings.local.json (file may be malformed)"
        fi
        _dredd_managed_log "$pr" "$sid" "manual-cleanup-remove" "$rules"
        REMOVED=$((REMOVED+1))
      fi
    fi
  fi
  dredd_sidecar_delete "$f"
done

say
say "Done. ${REMOVED} project(s) had managed rules stripped; ${SKIPPED} skipped (still active elsewhere); ${#TARGETS[@]} sidecar(s) deleted."
