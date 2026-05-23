# Plan — `dredd` integration skill for Claude Code

**Date:** 2026-05-23
**Owner:** TBD
**Status:** Draft plan, not yet implemented.

## Goal

Ship a Claude Code **skill** (a `.skill.md` packaged module discoverable
via the marketplace) that turns the user's local Claude Code into a
first-class Dredd client. The skill should make every Dredd interaction
the user has from their CLI feel native:

- **Install** Dredd hooks + API key into the user's `~/.claude/` (the
  flow we currently bootstrap via `claude-install-prompt.txt`).
- **Inspect** their own sessions / approvals / friction counters
  without opening the dashboard.
- **Adjudicate** Dredd denies — when a tool call is blocked, hand the
  user (and Claude) a structured way to send feedback ("this was a
  false positive", "approve this fingerprint", "raise the drift
  threshold for this session").
- **Tune** per-session trust mode, intent classifier mode, and the
  feature flags relevant to the user from the CLI.

Today, every one of these requires the dashboard, a curl with the right
Bearer key, or a manual edit to `~/.claude/settings.json`. The skill
removes those surface dependencies.

## Why a skill, not a CLI / not just docs

- **Skill = discoverable + sandboxed.** Claude Code discovers skills
  installed in `~/.claude/skills/` (or via the marketplace) and surfaces
  them at the top of its tool palette. Users don't have to remember the
  endpoint names or the curl invocations.
- **Skill = single source of truth for the auth flow.** Today the
  install prompt, the bundle README, and CLAUDE.md describe the same
  auth setup three times. A skill collapses that into one
  invocation-driven path.
- **Skill = embeddable in agent loops.** Other Claude-built tools can
  invoke the skill the same way they invoke any other (e.g. an IDE
  extension can ask the skill "what's the verdict on this tool call?").

## Surface — what users do with the skill

Each row is an entry-point the skill exposes. The "trigger" column is
how the user / Claude reaches it.

| Capability | Trigger | What happens |
|---|---|---|
| Install Dredd | `/dredd:install` | Walks the install (API key → hook script → settings.json merge → verify). Replaces today's `claude-install-prompt.txt`. |
| Show session status | `/dredd:status` | Prints current session ID, intent stack, mode, friction count, last 5 tool decisions. |
| Explain last deny | `/dredd:why` | Fetches the most recent deny on the active session, shows verdict + reasoning + stage. |
| Send deny feedback | `/dredd:feedback` | Opens a structured form for the user to send "false positive / correct" + free-text reason to a `/api/deny-feedback` endpoint. See "Feedback channel" below. |
| Approve a fingerprint manually | `/dredd:approve` | Lists pending denies; user picks one; skill calls `/api/approvals/manual` to record an explicit approval for that fingerprint. |
| Flip session mode | `/dredd:mode <interactive\|autonomous\|learn>` | Calls `/api/session-mode` with the user's session ID. |
| Toggle a feature flag | `/dredd:flag <DREDD_TACIT_APPROVAL_ENABLED=true>` | Per-session override (server-side support TBD; see "Server work needed"). |
| Tail the live feed | `/dredd:feed` | Streams `/api/feed` filtered to the user's sessions. |

The skill MUST default to the active session ID (read from
`~/.claude/dredd/state.json` written on each prompt by the existing
hook) so users don't have to copy-paste UUIDs.

## Feedback channel — the missing piece on the server today

Right now there is no endpoint to send "this deny was wrong" feedback.
The skill needs one to do its job. Proposed minimal shape:

```
POST /api/deny-feedback
Auth: Bearer API key
Body: {
  "session_id": "…",
  "tool_use_id": "…",
  "feedback": "false-positive" | "correct" | "should-have-denied",
  "reason": "free-text up to 1KB",
  "submitted_at": "ISO timestamp"
}
```

Storage: new DynamoDB table `jaid-deny-feedback`, primary key
`pk=FEEDBACK#<session_id>`, sort key `sk=<tool_use_id>#<feedback-id>`,
GSI on `feedback` so we can sweep "false-positive" rows for analysis.

This is also where we'd surface judge accuracy stats over time —
`(false-positive count / total denies)` per stage and per session is
the headline metric for tuning thresholds and the system prompt.

## Server work needed (separate from the skill itself)

1. **`POST /api/deny-feedback`** — new endpoint on hook role.
   Bearer-keyed, owner-checked.
2. **`POST /api/approvals/manual`** — let a user pre-approve a
   fingerprint without first hitting an "ask" prompt. Useful for the
   "I know this command is safe, just record consent for next time"
   case.
3. **`GET /api/session/active`** — returns the user's current /
   most-recent session ID + state. Avoids the skill having to scrape
   `~/.claude/dredd/state.json`. (Optional — local file is fine for v1.)
4. **`POST /api/session-flag`** — per-session feature-flag override
   (currently only `MODE` and `intent_mode` have per-session overrides;
   the Phase 9 / pattern-trust flags are global). Optional — useful
   when we ship more flags.
5. **Endpoint usage telemetry** — `/api/skill-events` (or just structured
   log lines) that capture skill invocations so we can see if the
   skill is being used + which entry-points see traffic.

The skill MAY ship in two phases:

- **Phase 1 (read-only + install):** install, status, why, feed,
  mode-flip. No new server endpoints required beyond what we have.
- **Phase 2 (feedback + manual approval):** depends on
  `/api/deny-feedback` + `/api/approvals/manual` landing. Skill is
  a no-op for these if the endpoints aren't there yet (returns
  "feature requires hook v0.1.X+").

## Skill layout

```
~/.claude/skills/dredd/
  skill.md                   — entry-point metadata + top-level prompt
  install.md                 — sub-skill: install Dredd
  status.md                  — sub-skill: status command
  why.md                     — sub-skill: explain last deny
  feedback.md                — sub-skill: send feedback
  approve.md                 — sub-skill: manual approval
  mode.md                    — sub-skill: flip session mode
  feed.md                    — sub-skill: tail feed
  lib/
    api.sh                   — thin wrappers around curl + jq
    detect-session.sh        — read ~/.claude/dredd/state.json
  README.md                  — operator-facing install / overview
```

Each sub-skill is self-contained markdown that Claude Code parses
as a prompt template. Common shared bits (auth header, base URL,
session-ID detection) come from `lib/`.

## Authentication model in the skill

- Reads `~/.claude/dredd/api-key` (the file the existing hook writes
  during install).
- Discovers the hook URL via `~/.claude/dredd/state.json` (cached
  from the most recent UserPromptSubmit) or, failing that, via
  `~/.claude/settings.json` `env.DREDD_URL`.
- Refuses to run if both are missing — prints a one-line pointer to
  `/dredd:install`.

The skill never asks the user to paste keys; the key is always read
from disk.

## Side benefit — the install prompt becomes obsolete

Once the skill is installed, the install prompt's job (walking Claude
through wiring up the hook) collapses into `/dredd:install`. The
skill itself can ship via the marketplace, so a brand-new user goes:

```
claude install dredd
/dredd:install
```

…and is fully integrated with no `curl` dance.

We can keep `claude-install-prompt.txt` for users who don't have the
skill yet (and the chicken/egg case where they need to bootstrap into
the marketplace), but it stops being the recommended path.

## Threats / risk surface

- **The skill becomes an attack surface itself.** A compromised
  marketplace listing could ship a `~/.claude/skills/dredd/` that
  reads `~/.claude/dredd/api-key` and exfils it. Mitigations:
  - Ship from a verified org account on the marketplace.
  - Sign skill releases (the skill marketplace's content-trust story).
  - The skill should never embed the API key in URLs, log lines, or
    `tool_input` — every reference reads from disk at use time.
- **`/api/deny-feedback` could be DoS'd** by an attacker with a valid
  key flooding it. Mitigation: rate-limit per ownerSub (10/min, 100/hr).
- **`/api/approvals/manual` is a privilege grant.** It must NOT let
  a user pre-approve a fingerprint they don't own / haven't been
  asked about. Implementation: require the (session_id, tool_use_id)
  to map to a real pending or recent ask, then record approval.

## Open questions

1. **Should the skill prompt the user before the install starts, the way
   `claude-install-prompt.txt` does today?** (Yes — same scope-locking
   guarantees apply.)
2. **Should `/dredd:feedback` block (wait for the server to ack) or
   fire-and-forget?** (Probably block in the happy path so the user
   sees confirmation; degrade to fire-and-forget on timeout.)
3. **Skill versioning:** how does the skill check the hook's version
   and refuse to call endpoints that don't exist yet?
   (Easy: `/api/health` returns `version`, skill compares to a `min_hook_version`
   field in `skill.md` frontmatter.)
4. **Discovery:** does the user discover the skill via marketplace,
   via a CLI install (`claude install dredd`), or via Dredd's own
   dashboard? (All three, with the dashboard's Integration tab
   becoming the canonical entry-point — adds a third option below
   "Or: let Claude install Dredd for you" + "Install manually".)

## Out of scope for this plan

- Native IDE-plugin integration (VS Code / JetBrains).
- Email / Slack notifications when a deny occurs.
- Multi-user dashboards beyond what the existing dashboard already does.
- Per-skill rate limits beyond the hook's existing `DREDD_AUTH_MODE` /
  API-key revocation primitives.

## Suggested next steps

1. Write `skill.md` for the read-only / install subset (Phase 1).
2. Implement `POST /api/deny-feedback` + the Dynamo table behind it.
3. Implement `POST /api/approvals/manual`.
4. Add `/dredd:feedback` + `/dredd:approve` sub-skills (Phase 2).
5. Ship to marketplace under a verified org.
6. Update CLAUDE.md "Integrating another machine with this prod stack"
   to point at the skill rather than the bundle download.
