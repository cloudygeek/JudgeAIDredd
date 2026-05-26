# Lightweight `/api/sessions` via META aggregates

**Date:** 2026-05-26
**Status:** Design approved, pending spec review
**Author:** brainstormed with Adrian

## Problem

`GET /api/sessions` (the dashboard's session list) reconstructs **up to 50 full
sessions per call** — `listSessions(50)` then `Promise.all` of one
`buildSessionLogShape` per live session, each Querying *all* items of a
session. The dashboard UI polls this every 5 s. On the prod `jaid-sessions`
table (~20k items / 36 MB) that fan-out saturated the single-threaded event
loop and caused a dashboard outage on 2026-05-26 (the trivial `/health` check
couldn't get a turn → ECS replaced the task → permanent crash-loop).

A short-TTL (5 s) response cache (already shipped) collapsed concurrent
polls/tabs into one computation per window and stopped the wedge — but each
window still reads **~1,500 RRU** (≈30 RRU × 50 full reconstructions), i.e.
**~18K read-units/min** while a tab is open. The list view does not need full
reconstructions; it needs a handful of per-session **aggregates**.

## Goal

Make `/api/sessions` a single cheap GSI query instead of a 50× full-session
fan-out, by maintaining the aggregates the list needs on the session META row.
Full reconstruction stays only on the detail view (`/api/session-log/:id`).

## Pricing (why it's worth it)

`jaid-sessions` is on-demand (PAY_PER_REQUEST), eu-west-1 (~$0.28 / M RRU).

| | Reads | Cost (1 tab open) |
|---|---|---|
| Now (5 s cache) | ~18K RRU/min (~1,500 RRU/window) | ~$50/mo work-hours → ~$217/mo 24×7 |
| After this change | ~25 RRU/query (1 GSI read of ≤50 META rows) | ~$1–4/mo |

~98 % read reduction. The new per-`/track` counter write is an atomic `ADD`
on an already-written row → **<$1/mo** (effectively free if folded into the
existing META write). The 5 s cache already makes cost independent of tab
count. Beyond cost, the list computation becomes trivial regardless of
polling / tab-count / session-count, so the **outage class is eliminated** and
the ALB health check stays strict.

## Architecture

### New META aggregate fields (maintained incrementally)

On the per-session META row (`pk=SESSION#<id>`, `sk=META`):

- `toolCallCount` — total tool calls recorded.
- `deniedCount` — tool calls whose decision was `deny`.
- `fileWriteCount` — number of **distinct** file paths written.
- `lastClassification` — classification of the most recent turn metric
  (`on-task` / `scope-creep` / `drifting` / `hijacked`, etc.).

Already present and reused (no new work): `clientIp`, `userPermissions`,
`currentTurn` (= turns), `originalTask`, `startedAt`, `endedAt`, `ownerSub`,
`ownerEmail`.

### Write path (`src/dynamo-session-store.ts`, hot path)

Fold counter maintenance into the per-record writes the store already issues
on `/track`:

- **record tool call:** in addition to writing the `TOOL#` item, `UpdateItem`
  the META row with `ADD toolCallCount :one` and, when the decision is `deny`,
  `ADD deniedCount :one`.
- **first write of a new file path:** when a `FILE#W#<pathHash>` item is
  created for a path not seen before this session, `ADD fileWriteCount :one`.
  (Subsequent writes to the same path bump that file's `writeCount` but not the
  distinct-file counter.)
- **record turn metric:** `SET lastClassification = :c` on META.

Use **atomic `ADD`** so concurrent updates never need a read-modify-write and
can't race. These updates piggyback on the writes the store already performs;
they are best-effort and swallowed on failure exactly like the existing
fire-and-forget `/track` writes — **a counter write must never break the hook**.

The **in-memory store** (`src/in-memory-session-store.ts`, local/dev) derives
the same four values from its in-memory arrays in `listSessions` — no extra
writes. `CachedSessionStore` passes `listSessions` through to the backing
store.

### Read path

- `SessionSummary` (`src/session-store.ts`) gains `toolCallCount`,
  `deniedCount`, `fileWriteCount`, `lastClassification` (all optional for
  backward-compat). `listSessions` populates them from the META item (Dynamo)
  or in-memory state.
- `/api/sessions` (`src/server-dashboard.ts`) builds **lightweight** entries
  directly from `listSessions` — **no `buildSessionLogShape` call**:

  ```
  {
    sessionId, originalTask,
    timestamp: startedAt, startedAt, endedAt,
    summary: { toolCalls: toolCallCount, denied: deniedCount,
               filesWritten: fileWriteCount, turns: currentTurn },
    turnMetrics: [{ classification: lastClassification }],
    clientIp, userPermissions, ownerSub, ownerEmail
  }
  ```

  The admin "all"-view disk-JSON fallback path is unchanged (those legacy files
  already contain full data). The 5 s response cache stays.
- The **detail view** `/api/session-log/:id` is unchanged — it still calls the
  full `buildSessionLogShape` for the single clicked session.

### UI (`src/web/dashboard.html`, minimal)

The list already degrades gracefully: `buildToolTip` and `buildDeniedTip` fall
back to `s.summary` counts with a "detail not recorded" note, and clicking a
row opens the full detail. **One tweak:** `buildFileTip` currently shows
"No Files Written" when its array argument is absent — give it the same
count-fallback ("N files — open the session for detail") so a lightweight
entry with `filesWritten` count but no array reads correctly. The list-row
render passes the count to it.

No other UI change: counts, classification badge, task, IP, and the
user-permissions badge all read fields the lightweight entry provides.

## Backfill / compatibility

Sessions created **before** this deploy have no META counter fields. For them
`listSessions` returns the counters as `0`/absent, so the list shows `0` tools
/ denied / files (the classification badge falls back to `on-task`). Their full
detail remains correct on click (`/api/session-log/:id` recomputes from items).
This is an accepted limitation: it affects only historical rows, not the polled
live view (active sessions are created after the deploy and accrue accurate
counters). No migration is performed (YAGNI).

## Error handling

- Counter `UpdateItem` failures are caught and ignored (best-effort,
  fire-and-forget parity) — never propagated to the hook response.
- A missing/undefined counter on read is treated as `0`.
- `lastClassification` absent → list renders the default `on-task` badge (as
  today when no turn metrics exist).

## Testing

`npx tsx` suites under `hooks/tests/`:

- **Tracker / store counters:** recording a tool call increments
  `toolCallCount` (and `deniedCount` on a deny); a first-time file path
  increments `fileWriteCount` (a repeat path does not); a turn metric updates
  `lastClassification`. Verified against both `InMemorySessionStore` and
  `DynamoSessionStore` with an injected fake document client (assert the
  `ADD`/`SET` UpdateItem shapes).
- **`listSessions`** returns the four aggregates from META (Dynamo) and from
  in-memory state.
- **`/api/sessions` lightweight:** with a stubbed store, the handler returns
  the lightweight shape and does **not** invoke `buildSessionLogShape` (assert
  via a spy/no-op that would throw if called).
- **`buildFileTip` count fallback:** a manual/structural check that an entry
  with a `filesWritten` count but no array renders "N files" not "No Files
  Written".

## Out of scope (YAGNI)

- Backfilling counters onto pre-existing sessions.
- Changing what the detail view computes.
- Replacing the 5 s response cache (kept as a cheap second layer).
- Reworking `listSessions` pagination or the admin disk-fallback path.

## Key files

| File | Change |
|---|---|
| `src/session-store.ts` | `SessionSummary` + 4 optional aggregate fields |
| `src/dynamo-session-store.ts` | atomic `ADD`/`SET` counter maintenance on META writes; return counters in `listSessions` |
| `src/in-memory-session-store.ts` | derive counters in `listSessions` |
| `src/session-tracker.ts` | thread the deny decision / new-path / classification signals to the store counter updates (if not already available at the write call site) |
| `src/server-dashboard.ts` | `/api/sessions` lightweight projection (drop `buildSessionLogShape` fan-out) |
| `src/web/dashboard.html` | `buildFileTip` count fallback + pass count from the row |
| `hooks/tests/test_lightweight_sessions.ts` | new test suite |
