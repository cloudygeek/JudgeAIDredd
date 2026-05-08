#!/usr/bin/env bash
# Run the same prompt sequence twice (with/without Dredd) and emit two
# asciinema casts that can be played back side-by-side via player.html.
#
# Usage: harness/run-pair.sh prompts.txt
#
# prompts.txt: one prompt per line. Blank lines ignored.
#
# Requires: tmux, asciinema, claude (Claude Code CLI).

set -euo pipefail

PROMPTS_FILE="${1:?usage: run-pair.sh prompts.txt}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$HERE/casts/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

# Two pre-built CLAUDE_CONFIG_DIRs. Populate harness/configs/{dredd-on,dredd-off}
# with copies of ~/.claude — the on variant has the Dredd hooks block in
# settings.json, the off variant has it stripped. See harness/README.md.
CONFIG_ON="$HERE/configs/dredd-on"
CONFIG_OFF="$HERE/configs/dredd-off"

for d in "$CONFIG_ON" "$CONFIG_OFF"; do
  if [ ! -d "$d" ]; then
    echo "error: missing $d — see harness/README.md" >&2
    exit 1
  fi
done

# Detect and dismiss startup dialogs that block the prompt:
#   - MCP-server approval ("Space to select · Enter to confirm · Esc to
#     reject all") — we send Esc to skip all MCP servers since the
#     example prompts don't need them and we want a clean comparison.
#   - Any other modal that pins a footer like "Esc to reject" / "Esc to
#     cancel" — same treatment.
#
# Stops as soon as we see the steady-state "? for shortcuts" footer
# (which means we're at an empty prompt and ready for input).
dismiss_startup_dialogs() {
  local sess="$1" tries=0 pane
  while [ "$tries" -lt 10 ]; do
    pane=$(tmux capture-pane -p -t "$sess")
    if echo "$pane" | grep -q '? for shortcuts'; then
      return 0
    fi
    if echo "$pane" | grep -qE 'Esc to (reject|cancel)|reject all'; then
      tmux send-keys -t "$sess" Escape
      sleep 1
    else
      sleep 0.5
    fi
    tries=$(( tries + 1 ))
  done
  echo "warn: $sess never reached an empty prompt during dialog dismissal" >&2
}

# Poll capture-pane until Claude is idle, capped at 240s.
#
# Idle is positively confirmed by "? for shortcuts" (bottom-right hint
# at the empty prompt) AND negatively by absence of "esc to interrupt"
# (the busy marker that replaces it during tool calls / model thinking).
#
# We scan the WHOLE pane (no tail) because tmux repaints regions out
# of order: a single mid-render snapshot might omit the bottom hint
# even when Claude has actually returned to the prompt. The hint sits
# on the same row as a long, dynamic timestamp string ("MAC-...
# 14:19 08-May-26") which can also overwrite it transiently. Scanning
# the full pane catches it on whichever row tmux happens to have
# painted it on this tick.
#
# Require two consecutive matches (≥1s apart) so we don't false-trigger
# during a transient pre-tool-call repaint where the hint flashes back.
wait_for_idle() {
  local sess="$1" deadline=$(( $(date +%s) + 240 )) hits=0 pane
  while [ "$(date +%s)" -lt "$deadline" ]; do
    pane=$(tmux capture-pane -p -t "$sess")
    if echo "$pane" | grep -q '? for shortcuts' && \
       ! echo "$pane" | grep -q 'esc to interrupt'; then
      hits=$(( hits + 1 ))
      if [ "$hits" -ge 2 ]; then
        sleep 1   # one extra tick to let the last frame render
        return 0
      fi
    else
      hits=0
    fi
    sleep 0.5
  done
  echo "warn: $sess didn't return to prompt within 240s" >&2
}

run_one() {
  local label="$1" config_dir="$2"
  local claude_sess="claude-$label-$$"
  local rec_sess="rec-$label-$$"
  local cast="$OUT_DIR/$label.cast"

  echo "==> recording $label (config: $config_dir)"

  # 1. Claude in a detached tmux session.
  CLAUDE_CONFIG_DIR="$config_dir" \
    tmux new-session -d -s "$claude_sess" -x 200 -y 50 "claude"

  # 2. asciinema in another detached tmux session, attached to the first.
  #    The outer tmux gives asciinema a pty; neither session is displayed.
  #    Force asciicast-v2 — asciinema 3.x defaults to v3 which older
  #    asciinema-player builds don't read.
  tmux new-session -d -s "$rec_sess" -x 200 -y 50 \
    "asciinema rec --quiet --overwrite --output-format asciicast-v2 --command 'tmux attach -t $claude_sess' '$cast'"

  # 3. Wait for Claude to finish booting and dismiss any startup dialogs
  #    we don't want to record (MCP-server approval, model picker, etc.).
  #    Theme + trust-folder dialogs are pre-acked once when configs are
  #    seeded; everything else gets dismissed here so the recording
  #    starts cleanly.
  sleep 3
  dismiss_startup_dialogs "$claude_sess"

  # 4. Drive prompts.
  while IFS= read -r prompt; do
    [ -z "$prompt" ] && continue
    echo "    > $prompt"
    tmux send-keys -t "$claude_sess" "$prompt" Enter
    wait_for_idle "$claude_sess"
  done < "$PROMPTS_FILE"

  # 5. Quit Claude cleanly so the cast captures the exit.
  tmux send-keys -t "$claude_sess" "/exit" Enter
  sleep 2

  tmux kill-session -t "$claude_sess" 2>/dev/null || true
  tmux kill-session -t "$rec_sess"   2>/dev/null || true

  echo "    saved $cast"
}

# Run serially. Cast timestamps are relative to recording start, so
# side-by-side playback works regardless of when each was recorded.
run_one "dredd-off" "$CONFIG_OFF"
run_one "dredd-on"  "$CONFIG_ON"

# Drop a copy of the player next to the casts for convenience.
cp "$HERE/player.html" "$OUT_DIR/player.html"
echo
echo "done. open $OUT_DIR/player.html"
