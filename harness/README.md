# Side-by-side replay harness

Drives `claude` in a headless tmux pane, records the session via asciinema,
and produces two `.cast` files (with/without Dredd) that play back
synchronised in `player.html`.

## One-time setup

```bash
brew install tmux asciinema     # if you don't already have them

# Two CLAUDE_CONFIG_DIRs that differ only in the hooks block.
cp -R ~/.claude harness/configs/dredd-on
cp -R ~/.claude harness/configs/dredd-off

# In dredd-off/settings.json, remove the "hooks" block (or set it to {}).
# In dredd-on/settings.json, leave the Dredd PreToolUse/UserPromptSubmit/etc
# hooks intact (this is the variant from hooks/settings.json.example).
```

The two configs are full copies because Claude Code reads more than just
`settings.json` from `CLAUDE_CONFIG_DIR` (projects, todos, shell snapshots).
Sharing a dir between runs cross-contaminates state.

## Run

```bash
chmod +x harness/run-pair.sh
harness/run-pair.sh harness/prompts.example.txt
```

Output lands in `harness/casts/<utc-timestamp>/`:

- `dredd-off.cast`
- `dredd-on.cast`
- `player.html` (copy)

Open the `player.html` in a browser and hit "play both".

## Notes / things that will probably need tuning

- **`wait_for_idle` regex** in `run-pair.sh` — Claude's prompt rendering
  uses box-drawing characters that vary by version. Run once, eyeball
  `tmux capture-pane -p -t claude-dredd-off-<pid>` mid-run, tighten the
  pattern. Current guess: `│ >` or a bare `>` line.
- **`idleTimeLimit: 2`** in `player.html` collapses long idle gaps in
  playback so 30s of "Claude thinking" doesn't desync the panes
  visually. Drop it for true real-time playback.
- **Permission prompts**: if Dredd returns `ask`, Claude Code surfaces a
  TUI dialog. The harness doesn't auto-answer those — extend
  `wait_for_idle` to detect the dialog and `send-keys` an answer
  (`1 Enter` for yes / `2 Enter` for no, depending on Claude version).
- **/exit**: some Claude versions use `/quit`. Adjust if the cast hangs
  at the end.
