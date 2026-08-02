# Friction A/B harness

Runs one free-form task twice — once against **vanilla Claude Code** (no
hooks at all) and once with the **Dredd hooks wired** — recording each leg
as an asciinema cast and counting how many native permission dialogs the
user had to answer.

The question it answers: *how much of Claude Code's permission nagging
does Dredd absorb?*

## What it measures

The headline number is **dialogs per tool call**, not raw dialog count.
The task prompt is free-form, so the two legs will not execute the same
number of tool calls — an arm that happened to do 14 calls would show more
dialogs than one that did 8 regardless of Dredd. Raw counts are reported
alongside for context.

Dialog counts come from the harness itself: `wait_for_idle` already has to
detect a permission modal in order to answer it, so it logs each one to
`<arm>.dialogs.log` before pressing Enter. Tool-call counts come from
Claude Code's own transcript JSONL. Neither number comes from watching the
recording.

For the `dredd-on` leg only, two independent cross-checks are available
after the run using the session id in `dredd-on.sessionid`:

```bash
KEY=$(cat ~/.claude/dredd/api-key)
SID=$(cat harness/casts/<ts>/dredd-on.sessionid)
curl -s -H "Authorization: Bearer $KEY" https://dredd-hook.acta.io/api/notifications/$SID   # dialog counter
curl -s -H "Authorization: Bearer $KEY" https://dredd.acta.io/api/session-log/$SID | jq .   # per-call decisions
```

`/api/notifications/:id` is in-memory on the hook container — read it
promptly after the run, while sticky routing still pins to the same task.

## One-time setup

```bash
brew install tmux asciinema      # jq you already have
harness/seed-configs.sh --force  # build the two CLAUDE_CONFIG_DIRs

# Then sign in ONCE per arm — see "Authentication" below. This is required.
CLAUDE_CONFIG_DIR="$PWD/harness/configs/dredd-off" claude   # /login
CLAUDE_CONFIG_DIR="$PWD/harness/configs/dredd-on"  claude   # /login
```

### Authentication (the non-obvious part)

Claude Code keeps its OAuth token in the **macOS Keychain, keyed by config
directory** — `Claude Code-credentials` for the default `~/.claude`, and
`Claude Code-credentials-<hash>` for each custom `CLAUDE_CONFIG_DIR`. A
seeded config dir therefore does **not** inherit your normal login, no
matter what gets copied into it. Copying `.credentials.json` does not help
either; on this machine that file's token expired 2026-05-24 and the live
credential is Keychain-only.

Left undetected this failure is silent and looks like a result: Claude
answers the prompt with `Login expired · Please run /login`, does no work,
and the run exits 0 reporting **0 tool calls and 0 dialogs**. `run-pair.sh`
now preflights each arm with `claude -p` and refuses to start if auth is
missing.

`seed-configs.sh` copies `~/.claude` into `configs/dredd-off` and
`configs/dredd-on` (so the onboarding, theme and trust-folder dialogs are
already acked and don't pollute the recording), then rewrites each
`settings.json` so the **only** behavioural difference is the hooks block.

Three things it deliberately controls for:

- **Plugins are stripped** (`enabledPlugins: {}`, `plugins/` excluded).
  With the superpowers plugin present the agent invokes the brainstorming
  skill and starts asking clarifying questions instead of building the
  page, which destroys the scenario.
- **No permissions block in either arm.** The vanilla leg must prompt for
  everything. The script hard-fails if permission rules appear, because
  that would silently void the comparison.
- **Identical model and effort** in both arms — a different model changes
  the tool-call count.

`configs/*` is gitignored except `settings.json`; the seeded tree contains
real credentials.

## Run

```bash
harness/run-pair.sh                          # both legs, default prompt
ARMS="dredd-off" harness/run-pair.sh         # one leg only
```

Viewing the result needs a local web server — `player.html` fetches the
casts over XHR, which browsers block under `file://`:

```bash
cd harness/casts/<utc-timestamp> && python3 -m http.server 8900
open http://localhost:8900/player.html
```

Output lands in `harness/casts/<utc-timestamp>/`:

| File | Contents |
|---|---|
| `<arm>.cast` | asciinema recording |
| `<arm>.dialogs.log` | one line per permission dialog answered |
| `<arm>.tools.txt` | tool names from the transcript, one per line |
| `<arm>.transcript.jsonl` | copy of Claude Code's transcript |
| `<arm>.sessionid` | for joining against Dredd's session log |
| `<arm>.workspace/` | what the agent actually built |
| `results.tsv` | arm / toolCalls / dialogs / dialogsPerCall / secs |
| `player.html` | side-by-side viewer — `open` it |

Every run resets `run-workspace/` from `friction-workspace/` first,
deleting any `.claude/settings.local.json` and sweeping Dredd's
managed-allow sidecars. Without that reset the second leg sees the first
leg's `index.html` and does far less work, and leftover allow rules stop
the vanilla arm prompting at all.

## Things that will need tuning

- **`DIALOG_BODY` / `DIALOG_FOOT`** in `run-pair.sh` are the permission
  modal matcher, written against an older Claude Code. **Check these
  first.** If the wording has drifted the harness hangs *and* silently
  reports zero dialogs, which would make every number in the run wrong.
  Run the vanilla leg alone, then confirm `dredd-off.dialogs.log` is
  non-empty and its lines look like real questions.
- **`IDLE_HINT` / `BUSY_HINT`** — same risk, same fix. Mid-run,
  `tmux capture-pane -p -t claude-dredd-off-<pid>` shows what the matcher
  is actually seeing.
- **`IDLE_CAP`** (default 900s) is per prompt, not per run.
- **`/exit`** — some versions use `/quit`. Adjust if a cast hangs at the end.

## Scaling to N runs

`run-pair.sh` does one pass of each leg. For a multi-run study, loop it
and interleave the arms (off, on, off, on…) rather than running 10 of one
then 10 of the other, so any drift in prod Dredd or API latency hits both
arms evenly. Concatenate the per-run `results.tsv` files and report
medians with spread.

Casts are small — roughly 0.5–2 MB each raw, and they gzip 10–20× because
the TUI repaints are near-identical — so storage is not a constraint.
