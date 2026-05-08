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

# Poll capture-pane until the prompt prefix reappears, capped at 120s.
# The regex is the fragile bit — adjust it after eyeballing one run.
wait_for_idle() {
  local sess="$1" deadline=$(( $(date +%s) + 120 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # Match the empty Claude prompt: a `❯` followed by only whitespace.
    # The pane is right-padded with spaces to terminal width, hence \s*$.
    if tmux capture-pane -p -t "$sess" | tail -5 | grep -qE '❯[[:space:]]*$'; then
      sleep 1   # one extra tick to let the last frame render
      return 0
    fi
    sleep 0.5
  done
  echo "warn: $sess didn't return to prompt within 120s" >&2
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

  # 3. Let Claude render its prompt.
  sleep 3

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
