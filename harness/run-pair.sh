#!/usr/bin/env bash
# Friction A/B: run the same free-form task twice — once with no hooks at
# all (vanilla Claude Code), once with the Dredd hooks wired — and record
# each leg as an asciinema cast plus a machine-readable count of how many
# native permission dialogs the user had to answer.
#
# Usage: harness/run-pair.sh [prompts.txt]
#          default prompts file: harness/prompts.friction.txt
#
# Env:
#   ARMS="dredd-off dredd-on"   which legs to run, in order
#   IDLE_CAP=900                per-prompt wall-clock cap, seconds
#
# Requires: tmux, asciinema, jq, claude (Claude Code CLI).
#
# Outputs to harness/casts/<utc-timestamp>/:
#   <arm>.cast          asciinema recording
#   <arm>.dialogs.log   one line per permission dialog answered
#   <arm>.tools.txt     tool_use names pulled from the transcript
#   results.tsv         arm / toolCalls / dialogs / dialogsPerCall / secs
#   player.html         side-by-side viewer

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PROMPTS_FILE="${1:-$HERE/prompts.friction.txt}"
TEMPLATE="$HERE/friction-workspace"
WS="$HERE/run-workspace"
OUT_DIR="$HERE/casts/$(date -u +%Y%m%dT%H%M%SZ)"
ARMS="${ARMS:-dredd-off dredd-on}"
IDLE_CAP="${IDLE_CAP:-900}"

# The permission-dialog matcher. Claude Code renders a modal whose body
# starts "Do you want to <verb>..." and whose footer offers Esc to cancel.
# TUNE THIS FIRST if the pilot run hangs or reports 0 dialogs — it was
# written against an older Claude Code and the wording drifts between
# versions.
DIALOG_BODY='Do you want to'
DIALOG_FOOT='Esc to cancel'
# Steady-state footer shown at an empty prompt, and the busy marker that
# replaces it while a tool call or model turn is in flight.
IDLE_HINT='? for shortcuts'
BUSY_HINT='esc to interrupt'

for tool in tmux asciinema jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool not installed — brew install tmux asciinema jq" >&2; exit 1; }
done
command -v claude >/dev/null 2>&1 || { echo "error: claude not on PATH" >&2; exit 1; }
[ -f "$PROMPTS_FILE" ] || { echo "error: no prompts file at $PROMPTS_FILE" >&2; exit 1; }
[ -d "$TEMPLATE" ]     || { echo "error: no template workspace at $TEMPLATE" >&2; exit 1; }

# Fail fast if an arm's config dir isn't logged in.
#
# Claude Code namespaces its OAuth token in the macOS Keychain PER config
# directory ("Claude Code-credentials" for the default,
# "Claude Code-credentials-<hash>" for a custom CLAUDE_CONFIG_DIR), so the
# seeded dirs do NOT inherit the operator's normal login. Left undetected
# this is silent and looks like a result: Claude answers the prompt with
# "Login expired · Please run /login", does no work, and the run exits 0
# reporting 0 tool calls and 0 dialogs.
#
# `claude -p` exits 0 even when auth fails, so the text has to be matched.
preflight_auth() {
  local arm="$1" dir="$HERE/configs/$arm" out
  [ -d "$dir" ] || {
    echo "error: missing $dir — run harness/seed-configs.sh first" >&2; exit 1; }

  out=$(CLAUDE_CONFIG_DIR="$dir" claude -p "reply with the single word ok" 2>&1 | head -20 || true)
  if printf '%s' "$out" | grep -qiE 'Failed to authenticate|OAuth session expired|Please run /login|Login expired|Invalid API key'; then
    {
      echo "error: config dir '$arm' is not authenticated."
      echo
      echo "  Claude Code stores its OAuth token in the macOS Keychain keyed by"
      echo "  config directory, so a custom CLAUDE_CONFIG_DIR does not inherit"
      echo "  your normal login. Each arm needs its own one-time sign-in:"
      echo
      echo "      CLAUDE_CONFIG_DIR=\"$dir\" claude"
      echo "      # then type /login and complete it in the browser"
      echo
      echo "  Probe said:"
      printf '%s\n' "$out" | grep -iE 'authenticate|OAuth|login|API key' | sed 's/^/      /'
    } >&2
    exit 1
  fi
  echo "    auth ok: $arm"
}

echo "==> preflight"
for arm in $ARMS; do preflight_auth "$arm"; done

mkdir -p "$OUT_DIR"

# Restore the workspace to a byte-identical starting state. Without this
# the second leg sees the first leg's index.html and does far less work,
# and any allow rules left in .claude/settings.local.json would stop the
# vanilla arm prompting at all.
reset_workspace() {
  rm -rf "$WS"
  cp -R "$TEMPLATE" "$WS"
  rm -rf "$WS/.claude"
  if [ -x "$REPO/hooks/dredd-cleanup.sh" ]; then
    "$REPO/hooks/dredd-cleanup.sh" --project "$WS" --yes --quiet >/dev/null 2>&1 || true
  fi
}

# Dismiss the startup dialogs we don't want in the recording (MCP-server
# approval, etc). Stops as soon as the empty-prompt footer appears.
dismiss_startup_dialogs() {
  local sess="$1" tries=0 pane
  while [ "$tries" -lt 12 ]; do
    pane=$(tmux capture-pane -p -t "$sess" 2>/dev/null || true)
    echo "$pane" | grep -qF "$IDLE_HINT" && return 0
    if echo "$pane" | grep -qE 'Esc to (reject|cancel)|reject all'; then
      tmux send-keys -t "$sess" Escape; sleep 1
    else
      sleep 0.5
    fi
    tries=$(( tries + 1 ))
  done
  echo "    warn: never reached an empty prompt during startup" >&2
}

# Poll until Claude is back at an idle prompt, answering (and COUNTING)
# every permission dialog on the way.
#
# Idle is confirmed positively by the empty-prompt footer and negatively
# by absence of the busy marker, twice in a row — tmux repaints regions
# out of order, so a single snapshot can catch a misleading frame.
wait_for_idle() {
  local sess="$1" log="$2"
  local deadline=$(( $(date +%s) + IDLE_CAP )) hits=0 pane q gone

  while [ "$(date +%s)" -lt "$deadline" ]; do
    pane=$(tmux capture-pane -p -t "$sess" 2>/dev/null || true)

    if echo "$pane" | grep -qF "$DIALOG_BODY" && echo "$pane" | grep -qF "$DIALOG_FOOT"; then
      q=$(echo "$pane" | grep -F "$DIALOG_BODY" | head -1 | tr -s ' ' | sed 's/^ *//;s/ *$//')
      printf '%s\t%s\n' "$(date -u +%H:%M:%S)" "$q" >> "$log"
      echo "      dialog: $q"
      tmux send-keys -t "$sess" Enter

      # Wait for the modal to actually clear before looking again, so one
      # dialog can't be counted twice across repaints.
      gone=0
      for _ in $(seq 1 20); do
        sleep 0.25
        tmux capture-pane -p -t "$sess" 2>/dev/null | grep -qF "$DIALOG_FOOT" || { gone=1; break; }
      done
      [ "$gone" -eq 1 ] || echo "      warn: dialog still on screen after answering" >&2
      hits=0
      continue
    fi

    if echo "$pane" | grep -qF "$IDLE_HINT" && ! echo "$pane" | grep -qF "$BUSY_HINT"; then
      hits=$(( hits + 1 ))
      if [ "$hits" -ge 2 ]; then sleep 1; return 0; fi
    else
      hits=0
    fi
    sleep 0.5
  done
  echo "    warn: prompt did not return within ${IDLE_CAP}s" >&2
}

# Pull the tool-call count out of Claude Code's own transcript. Each arm's
# CLAUDE_CONFIG_DIR is seeded without projects/, so exactly one transcript
# exists afterwards and there is nothing to disambiguate.
harvest_transcript() {
  local config_dir="$1" arm="$2"
  local tx
  tx=$(find "$config_dir/projects" -name '*.jsonl' -type f 2>/dev/null \
        | xargs ls -t 2>/dev/null | head -1 || true)

  if [ -z "$tx" ]; then
    echo "    warn: no transcript found under $config_dir/projects" >&2
    echo 0 > "$OUT_DIR/$arm.toolcount"
    : > "$OUT_DIR/$arm.tools.txt"
    return 0
  fi

  cp "$tx" "$OUT_DIR/$arm.transcript.jsonl"
  jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' \
     "$tx" 2>/dev/null > "$OUT_DIR/$arm.tools.txt" || : > "$OUT_DIR/$arm.tools.txt"
  wc -l < "$OUT_DIR/$arm.tools.txt" | tr -d ' ' > "$OUT_DIR/$arm.toolcount"

  # Session id lets us join the Dredd arm against /api/session-log/:id.
  jq -r 'select(.sessionId != null) | .sessionId' "$tx" 2>/dev/null | head -1 \
     > "$OUT_DIR/$arm.sessionid" || true
}

run_one() {
  local arm="$1"
  local config_dir="$HERE/configs/$arm"
  local claude_sess="claude-$arm-$$" rec_sess="rec-$arm-$$"
  local cast="$OUT_DIR/$arm.cast" log="$OUT_DIR/$arm.dialogs.log"
  local started ended

  [ -d "$config_dir" ] || {
    echo "error: missing $config_dir — run harness/seed-configs.sh first" >&2; exit 1; }

  echo "==> $arm"
  : > "$log"
  reset_workspace
  started=$(date +%s)

  CLAUDE_CONFIG_DIR="$config_dir" \
    tmux new-session -d -s "$claude_sess" -x 200 -y 50 -c "$WS" "claude"

  # asciinema needs a pty; a second detached tmux session attached to the
  # first provides one without either session ever being displayed.
  # asciicast-v2 is forced because asciinema 3.x defaults to v3, which the
  # pinned asciinema-player build in player.html cannot read.
  tmux new-session -d -s "$rec_sess" -x 200 -y 50 \
    "asciinema rec --quiet --overwrite --output-format asciicast-v2 \
       --command 'tmux attach -t $claude_sess' '$cast'"

  sleep 4
  dismiss_startup_dialogs "$claude_sess"
  # Some versions swallow the first Enter on the welcome panel; a
  # space-then-backspace forces a redraw without leaving input residue.
  tmux send-keys -t "$claude_sess" Space BSpace
  sleep 1

  while IFS= read -r prompt; do
    [ -z "$prompt" ] && continue
    echo "    > ${prompt:0:70}..."
    tmux send-keys -t "$claude_sess" -l "$prompt"
    sleep 0.5
    tmux send-keys -t "$claude_sess" Enter
    wait_for_idle "$claude_sess" "$log"
  done < "$PROMPTS_FILE"

  tmux send-keys -t "$claude_sess" "/exit" Enter
  sleep 3
  tmux kill-session -t "$claude_sess" 2>/dev/null || true
  tmux kill-session -t "$rec_sess"   2>/dev/null || true

  ended=$(date +%s)
  echo $(( ended - started )) > "$OUT_DIR/$arm.secs"
  harvest_transcript "$config_dir" "$arm"

  # Snapshot what the agent actually built, for eyeballing afterwards.
  mkdir -p "$OUT_DIR/$arm.workspace"
  cp -R "$WS"/. "$OUT_DIR/$arm.workspace"/ 2>/dev/null || true

  echo "    cast    $cast ($(du -h "$cast" 2>/dev/null | cut -f1 || echo '?'))"
  echo "    dialogs $(wc -l < "$log" | tr -d ' ')"
  echo "    tools   $(cat "$OUT_DIR/$arm.toolcount")"
}

for arm in $ARMS; do run_one "$arm"; done

cp "$HERE/player.html" "$OUT_DIR/player.html"

{
  printf 'arm\ttoolCalls\tdialogs\tdialogsPerCall\tsecs\tcastBytes\n'
  for arm in $ARMS; do
    tc=$(cat "$OUT_DIR/$arm.toolcount" 2>/dev/null || echo 0)
    dl=$(wc -l < "$OUT_DIR/$arm.dialogs.log" 2>/dev/null | tr -d ' ' || echo 0)
    sc=$(cat "$OUT_DIR/$arm.secs" 2>/dev/null || echo 0)
    cb=$(wc -c < "$OUT_DIR/$arm.cast" 2>/dev/null | tr -d ' ' || echo 0)
    if [ "$tc" -gt 0 ]; then
      dpc=$(awk "BEGIN{printf \"%.2f\", $dl/$tc}")
    else
      dpc="n/a"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$arm" "$tc" "$dl" "$dpc" "$sc" "$cb"
  done
} | tee "$OUT_DIR/results.tsv" | column -t -s $'\t'

echo
echo "artifacts: $OUT_DIR"
echo "view:      open $OUT_DIR/player.html"
