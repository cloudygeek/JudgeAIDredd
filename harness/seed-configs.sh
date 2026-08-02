#!/usr/bin/env bash
# Build the two CLAUDE_CONFIG_DIRs used by run-pair.sh.
#
#   configs/dredd-off  — vanilla Claude Code, no hooks at all
#   configs/dredd-on   — identical, plus the full Dredd hooks block
#
# Both are seeded from ~/.claude so the onboarding/theme/trust-folder
# dialogs are already acked (otherwise they'd pollute the recording),
# then their settings.json is rewritten so the ONLY behavioural
# difference between the arms is the hooks block.
#
# Usage: harness/seed-configs.sh [--force]

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SRC="${CLAUDE_HOME:-$HOME/.claude}"
HOOK="$REPO/hooks/dredd-hook.sh"
DREDD_URL="${DREDD_URL:-https://dredd-hook.acta.io}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

for tool in rsync jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool not installed" >&2; exit 1; }
done
[ -f "$SRC/settings.json" ] || { echo "error: no $SRC/settings.json" >&2; exit 1; }
[ -x "$HOOK" ] || { echo "error: hook not executable at $HOOK" >&2; exit 1; }

# Excludes: the shared .rsync-exclude (bulk state) plus the extras that
# would otherwise change agent behaviour between runs.
#
#   plugins/  — MUST be excluded. With the superpowers plugin present the
#               agent invokes the brainstorming skill and starts asking
#               clarifying questions instead of building the page, which
#               destroys the scenario. enabledPlugins is also blanked below.
#   dredd/    — the hook reads $HOME/.claude/dredd/{api-key,managed} directly
#               (not $CLAUDE_CONFIG_DIR), so copying it is pure waste.
EXTRA_EXCLUDES=(plugins dredd jobs ide daemon.log daemon-auth-status.json
                mcp-needs-auth-cache.json .last-update-result.json
                'security_warnings_state_*' 'settings.json.bak*')

seed_one() {
  local label="$1" dest="$HERE/configs/$label"

  if [ -d "$dest" ] && [ "$FORCE" -ne 1 ]; then
    echo "  $label: exists, skipping (use --force to rebuild)"
    return 0
  fi
  rm -rf "$dest"
  mkdir -p "$dest"

  local args=(-a --quiet --exclude-from="$HERE/.rsync-exclude")
  for e in "${EXTRA_EXCLUDES[@]}"; do args+=(--exclude="$e"); done
  rsync "${args[@]}" "$SRC"/ "$dest"/

  echo "  $label: seeded $(du -sh "$dest" | cut -f1) from $SRC"
}

# Rewrite settings.json so the arms differ in exactly one key.
#
# Stripped from both: enabledPlugins (see above), and the agent-teams env
# vars, which add tool-call variance we don't want in a friction count.
# Kept identical in both: model + effortLevel — a different model would
# change the tool-call count and invalidate the comparison.
write_settings() {
  local label="$1" dest="$HERE/configs/$label"

  local base
  base=$(jq '
    .enabledPlugins = {}
    | del(.extraKnownMarketplaces)
    | del(.hooks)
    | .env = {}
  ' "$SRC/settings.json")

  if [ "$label" = "dredd-on" ]; then
    printf '%s' "$base" | jq \
      --arg hook "$HOOK" --arg url "$DREDD_URL" '
      .env = { "DREDD_URL": $url }
      | .hooks = {
          UserPromptSubmit:   [ { hooks: [ { type: "command", command: $hook, timeout: 30 } ] } ],
          PreToolUse:         [ { matcher: "*", hooks: [ { type: "command", command: $hook, timeout: 60 } ] } ],
          PostToolUse:        [ { matcher: "*", hooks: [ { type: "command", command: $hook, timeout: 10 } ] } ],
          PostToolUseFailure: [ { matcher: "*", hooks: [ { type: "command", command: $hook, timeout: 10 } ] } ],
          InstructionsLoaded: [ { hooks: [ { type: "command", command: $hook, timeout: 5 } ] } ],
          Stop:               [ { hooks: [ { type: "command", command: $hook, timeout: 10 } ] } ],
          SessionEnd:         [ { hooks: [ { type: "command", command: $hook, timeout: 10 } ] } ],
          PreCompact:         [ { hooks: [ { type: "command", command: $hook, timeout: 5 } ] } ],
          Notification:       [ { hooks: [ { type: "command", command: $hook, timeout: 5 } ] } ]
        }' > "$dest/settings.json"
  else
    printf '%s' "$base" > "$dest/settings.json"
  fi

  # No permissions block in either arm — that is the point. The vanilla
  # arm must prompt for everything; ~/.claude/settings.json currently has
  # zero permission rules, so this stays honest. Fail loudly if that ever
  # stops being true.
  if jq -e '.permissions | (.allow // []) + (.deny // []) + (.ask // []) | length > 0' \
       "$dest/settings.json" >/dev/null 2>&1; then
    echo "error: $label/settings.json carries permission rules — the vanilla" >&2
    echo "       arm would not prompt and the comparison would be void." >&2
    exit 1
  fi
}

# Claude Code keeps onboarding + account state in ~/.claude.json, which
# lives at the HOME root — NOT inside ~/.claude — so the rsync above never
# sees it. Without it a custom CLAUDE_CONFIG_DIR looks like a fresh
# install and boots into the "Select login method" screen instead of the
# prompt, which stalls the harness.
#
# Two things are rewritten on the way in:
#   projects{} — replaced with a single pre-trusted entry for the run
#                workspace, so the "Do you trust the files in this folder?"
#                dialog never fires. That dialog is NOT a permission prompt
#                and must not land in the friction count; worse, the
#                startup dismisser answers Escape, which on that dialog
#                means "no, exit".
#   mcpServers{} — emptied, so no MCP approval dialog either.
write_claude_json() {
  local label="$1" dest="$HERE/configs/$label"
  local ws="$HERE/run-workspace"

  [ -f "$HOME/.claude.json" ] || {
    echo "error: no $HOME/.claude.json — cannot pre-ack onboarding" >&2; exit 1; }

  jq --arg ws "$ws" '
    .mcpServers = {}
    | .projects = { ($ws): {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: 1,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
        allowedTools: [],
        mcpServers: {},
        disabledMcpjsonServers: [],
        enabledMcpjsonServers: []
      } }
  ' "$HOME/.claude.json" > "$dest/.claude.json"
  chmod 600 "$dest/.claude.json"

  jq -e '.hasCompletedOnboarding == true' "$dest/.claude.json" >/dev/null 2>&1 || {
    echo "error: $label/.claude.json lacks hasCompletedOnboarding — it will" >&2
    echo "       boot into the login screen and stall the harness." >&2
    exit 1; }

  # The copied .credentials.json is very likely stale (the OAuth token in
  # ~/.claude expired 2026-05-24). Auth on macOS comes from the Keychain,
  # which is per-user and shared across config dirs, so drop the dead file
  # rather than shipping an expired token that Claude Code has to reject.
  rm -f "$dest/.credentials.json"
}

echo "seeding CLAUDE_CONFIG_DIRs from $SRC"
for label in dredd-off dredd-on; do
  seed_one "$label"
  write_settings "$label"
  write_claude_json "$label"
done

echo
echo "settings diff (should be hooks + DREDD_URL only):"
diff <(jq -S . "$HERE/configs/dredd-off/settings.json") \
     <(jq -S . "$HERE/configs/dredd-on/settings.json") | sed 's/^/    /' || true
echo
echo "done."
