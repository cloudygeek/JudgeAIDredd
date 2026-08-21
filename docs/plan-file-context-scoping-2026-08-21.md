# Plan — Scope the judge's file-context to what the command actually touches

**Date:** 2026-08-21
**Author:** Claude Opus 5 (1M)
**Status:** Scoping. No code changes yet.
**Predecessor:** commit `9dafc90f` (0.1.541) — bounded the file-context dump on all three backends.
**Purpose:** Close the second half of the August Bedrock cost incident, and repair the security regression that `9dafc90f` introduced while fixing the first half.

---

## TL;DR

`9dafc90f` capped *how much* file context we send. It did not change *which* files we send: the renderer still starts from *every file written this session* and lets a flagged-first sort decide what survives a 40-file window. Two consequences, both measured against the real prod session that caused the incident (`67b60d78`, 1,026 written files, 15,925 Bash calls):

1. **Cost (partially fixed).** The trigger fires on **56.8%** of Bash calls, and every firing call rendered all 1,026 files — ~467K tokens. `9dafc90f` clamps that to ~3K tokens, but still spends the full 12K-char budget on a call whose command references a **median of 1 file**.
2. **Correctness (newly broken, not yet shipped).** Because `MULTI-WRITE` flags 481 of 1,026 files, the flagged-first sort fills the 40-file window with arbitrary files. **In 77.2% of firing commands the file the command actually references is crowded out and never reaches the judge** (median rank 327, cutoff 40). That is precisely the payload-splitting signal the block exists to carry.

The fix is to select by *relevance to this command* rather than by *flag status across the whole session*. **~3–4 hours across 4 tasks.** No new dependencies, no Bedrock/Dynamo calls, no flag needed for the correctness half.

**0.1.541 is not deployed** (prod was torn down 2026-08-21 10:47 CEST), so defect 2 has never run live. Ship this before redeploying and the regression never reaches production.

---

## Evidence

All figures replayed offline against DynamoDB rows for session `67b60d78-bf91-47f2-9eac-5a77cf91dbce`: 1,026 `FILE#W#` rows and 15,925 recorded Bash commands, run through the exact predicate in `src/handlers/evaluate.ts:271-277`.

| Measurement | Value |
|---|---:|
| Bash commands in session | 15,925 |
| Trigger fires (current substring predicate) | **9,179 (57.6%)** |
| …of which `git add\|commit\|push` | 734 (4.6%) |
| …of which reference a written file | 9,179 (57.6%) |
| Fires under a token-boundary predicate instead | 9,045 (56.8%) |
| **Pure substring accidents** (`brief.md` inside a longer word, etc.) | **134 (1.5% of firings)** |
| Files genuinely referenced per firing command | **median 1**, mean 9.8, p90 64, max 97 |
| Files rendered per firing command (pre-`9dafc90f`) | **1,026 — all of them** |
| Payload per firing call (pre-`9dafc90f`) | 1,868,187 chars ≈ **467K tokens** |
| Files flagged `MULTI-WRITE` | 481 (46.9%) |
| Files flagged `READ-THEN-WRITTEN` | 93 |
| Files flagged `CONTAINS-SENSITIVE-DATA` | **0** |
| **Referenced file crowded out of `9dafc90f`'s 40-file window** | **6,987 / 9,045 = 77.2%** |
| Rank of referenced file in `9dafc90f`'s ordering | median **327** (cutoff 40) |

Reproduce: `scratchpad/replay3.py` and `replay4.py` from this session, or re-derive from `jaid-sessions` (the table survives the teardown; TTL is 30d from last write).

### What this overturns

An earlier reading of the CloudWatch data attributed the over-firing to short basenames (`log`, `src`) matching everything by accident. **That is wrong and should not be carried into the design.** Substring accidents are 1.5% of firings. The trigger fires because developers genuinely do run commands against files they wrote earlier in the session — that is normal, and a session-scoped judge *should* notice it. The defect is the payload, not the predicate.

---

## Non-goals

- **Do not narrow the trigger to `git add|commit|push`.** It would drop 95% of firings, but those firings are legitimate: `flutter test map_view_test.dart` on a file written this session is exactly when payload-splitting evidence matters. Narrowing trades the whole detection surface for cost we can recover far more cheaply by scoping the payload.
- **Do not lower `MAX_TOTAL_CHARS`.** 12K chars is the right ceiling for a pathological call. The problem is that a 1-file call spends it.
- **No new flag for the correctness half.** Crowd-out is a straight bug; it should not soak behind a toggle. The cost half is a pure reduction and needs no flag either.

---

## Design

### One matcher, two consumers

Today the *trigger* (`evaluate.ts`) and the *renderer* (`file-context.ts`) each decide relevance independently, and disagree: the trigger asks "does this command touch any written file?", the renderer answers "here is every written file". Collapse both onto one exported matcher.

```ts
// src/file-context.ts

/** Files this command actually names, by full path or by basename token. */
export function referencedWrittenFiles<T extends { path: string }>(
  command: string,
  files: T[],
  cwd?: string | null,
): T[];
```

Matching rules, in order:
1. Full stored `path` appears literally in `command`.
2. `cwd`-relative form of the stored path appears (uses `cwdForEval`, already available at `evaluate.ts:112`).
3. Basename appears as a **token** — not glued to other filename characters. `/` *is* a legal preceding character (that is how paths are written); the guard is only against a basename embedded in a longer name.
   ```ts
   new RegExp(`(?<![A-Za-z0-9_.\\-])${escapeRe(base)}(?![A-Za-z0-9_\\-])`)
   ```

Rule 3's boundary check is what removes the 134 accidental firings. It is a small win and it is free, but it is **not** the point of this plan — do not let it become the headline.

`evaluate.ts` then becomes:

```ts
const referenced = referencedWrittenFiles(command, writtenFiles, cwdForEval);
if (referenced.length > 0 || /git\s+(add|commit|push)/.test(command)) {
  fileContext = await tracker.getFileContextForJudge(session_id, command, cwdForEval);
}
```

### Relevance tiers in the renderer

`renderFileContextForJudge(files, opts?)` gains `opts?: { command?: string; cwd?: string | null }`. **With no `opts` the current behaviour is unchanged** — other callers and the existing budget test keep passing.

With a command, files are partitioned and given budget in this order:

| Tier | Selection | Rendered as | Cap |
|---|---|---|---|
| 1. **Referenced** | `referencedWrittenFiles(command, files, cwd)` | full content, `PER_FILE_CHARS` each | `MAX_REFERENCED_FILES = 12` |
| 2. **Sensitive** | `containsCanary` | full content | `MAX_CANARY_FILES = 5` |
| 3. **Recent** | last written, excluding tiers 1–2 | full content | `MAX_RECENT_FILES = 5` |
| 4. **Rest** | everything else, flagged first | **path + flags only, no content** | `MAX_FILES_LISTED = 40` |

Plus a trailing one-line census that is always present, so the judge can never mistake a scoped block for a complete one:

```
(1,026 files written this session: 481 multi-write, 93 read-then-written, 0 sensitive.
 Showing 1 referenced by this command, 0 sensitive, 5 recent; 40 more listed by path only.)
```

Rationale per tier:
- **Tier 1** is the payload-splitting target — the file being executed. It is what `77.2%` of calls currently lose.
- **Tier 2** is the smoking gun for secret staging. It is 0 files in the observed session and rare in general, so an unconditional full-content slot costs nothing and must never be crowded out.
- **Tier 3** covers "wrote it, then ran it through a wrapper that does not name it" (`npm start`, `make`, `./run.sh`). Without this, scoping opens a blind spot that the old dump-everything behaviour accidentally covered.
- **Tier 4** preserves the existence-and-flags signal at negligible cost, which is what the multi-write count is actually good for. Dumping 481 multi-write bodies was never the useful part.

`MAX_TOTAL_CHARS = 12_000` still bounds the whole block. Tiers claim budget in order, so a pathological 97-reference command degrades gracefully instead of starving tier 2.

### Projected effect

| | pre-`9dafc90f` | `9dafc90f` (0.1.541) | + this plan |
|---|---:|---:|---:|
| Typical firing call | ~467K tok | ~3K tok | **~400 tok** |
| Referenced file reaches judge | ✅ always | ❌ 22.8% | ✅ always |
| Aug-equivalent judge spend | $7,558 | ~$136 | **~$30** |

The remaining cost delta is small in absolute terms; **the correctness row is the reason to do this.**

---

## Tasks

| # | Task | Files | Est. |
|---|---|---|---|
| **T-1** | Add `referencedWrittenFiles` + `escapeRe`. Pure, no deps. | `src/file-context.ts` | 45m |
| **T-2** | Add `opts` + the four tiers + census line to `renderFileContextForJudge`. Preserve no-opts behaviour exactly. | `src/file-context.ts` | 1h |
| **T-3** | Thread `command` + `cwd` through the store seam: widen `getFileContextForJudge(sessionId, command?, cwd?)` on the interface and all three backends; make the trigger in `evaluate.ts` call the shared matcher. | `src/session-store.ts`, `src/session-tracker.ts`, `src/cached-session-store.ts`, `src/dynamo-session-store.ts`, `src/handlers/evaluate.ts` | 45m |
| **T-4** | Tests (below) + CLAUDE.md test-surface row. | `hooks/tests/test_file_context_scoping.ts`, `CLAUDE.md` | 45m |

T-3 is the one with real regression risk: **all three backends must be widened together.** That is the exact failure mode that made the 0.1.530 cap a no-op for seven weeks. `getFileContextForJudge` is declared in `src/session-store.ts:370` and implemented at `session-tracker.ts:739`, `cached-session-store.ts:716`, `dynamo-session-store.ts:2186` — make the signature change on the interface first so `tsc` fails until every implementation follows.

---

## Tests

New `hooks/tests/test_file_context_scoping.ts` (`npx tsx`, same harness style as `test_file_context_budget.ts`):

**Matcher**
1. Full path in command → matched.
2. `cwd`-relative path → matched.
3. Basename as token (`cat src/index.js`) → matched.
4. Basename glued inside a longer name (`brief.md` in `debrief.md.bak`) → **not** matched.
5. Empty command / no files → no match, no throw.

**Tiers — the regression pins**
6. **1,026 files, command references file #900 → that file's content is present.** This is the 77.2% bug; it must fail against `9dafc90f`.
7. Canary file always rendered with content even when 1,000 multi-write files exist.
8. Recent-file tier fills when the command names nothing (`npm start`).
9. Tier 4 renders path+flags and **no content** for the remainder.
10. Census line reports the true total, not the rendered count.

**Budget — unchanged invariants**
11. Total output ≤ `MAX_TOTAL_CHARS` + census overhead for a 6,000-file session (carry over from `test_file_context_budget.ts`).
12. `renderFileContextForJudge(files)` with **no opts** byte-identical to current output.

**Cross-backend**
13. All three backends return the same string for the same state and command — the `9dafc90f` lesson, pinned.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Scoping hides a file that a genuine attack staged but the command does not name. | Tier 3 (recent) + tier 2 (canary) + the census line. The judge is told the block is scoped and how many files it is not seeing, so it can still ask for denial on suspicion. |
| R-2 | Only some backends get the new signature — the 0.1.530 failure repeated. | Change the interface first so the build breaks; test 13 pins cross-backend equality. |
| R-3 | Regex over `files.length × command` per call. | 1,026 files × one precompiled regex each is sub-millisecond, and it replaces an `O(n)` `String.includes` scan already running today. Compile basename regexes once per call, not per file-per-call. |
| R-4 | `wasReadFirst`/`writeCount` stop being visible now that most files lose their body. | They move into tier 4 flags and the census counts, which is where they were actually legible. No signal is dropped, only bodies. |

---

## Verification after deploy

1. `GET /api/bedrock-metrics` → `avgInputTokens` should sit in the low thousands, not tens of thousands.
2. CloudWatch Insights over `/ecs/judge-ai-dredd-prod/hook`:
   ```
   parse @message /in=(?<inTok>\d+)\/cr=/ | filter ispresent(inTok)
   | stats count() as calls, avg(inTok) as avgIn, max(inTok) as maxIn by bin(1d)
   ```
   Expect `maxIn` under ~20K. Pre-fix it was 625,492.
3. Spot-check one session-detail JSON for a `git commit` call and confirm the referenced file appears in the judge's block.

**Do step 2 within a day of deploying.** The 0.1.530 post-deploy check was never run, which is the only reason a no-op fix looked done for seven weeks.
