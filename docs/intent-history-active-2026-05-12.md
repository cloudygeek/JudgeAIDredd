# Design — Intent History + Active Set

**Date:** 2026-05-12
**Branch:** `intent-history-active`
**Predecessors:**
- `2e38d4db` (fix: trimStack no longer reanchors stale original — small fix landed on `main` to unblock current sessions)
- `b60aee13` (fix: new-task pivot evicts original — earlier related fix on `main`)
- `9841b82e` (fix: rehydrate continuation with persisted originalIntent — `claude --continue` correctness)

This document proposes replacing the single in-memory intent stack with a two-layer model: a per-session **intent history** that retains every intent the session ever had, and an **active set** that is the working subset the judge sees on each `/evaluate`.

---

## Why we need this

### The bug pattern we keep hitting

Every recent intent-tracker fix has been chasing the same shape:

| Commit | Symptom | Root cause |
|---|---|---|
| `b60aee13` | new-task pivot didn't evict turn-1 goal | original treated as session-defining poison pill |
| `9841b82e` | `--continue` re-anchored on the wrong goal | rehydration registered the continuation prompt as the goal |
| `2e38d4db` | long sessions stuck anchoring the judge on turn 1 | trimStack re-prepended the original on every overflow |

All three are variants of: *we conflate "this is the historic record of the session" with "this is what the judge should consider right now"*. The same data structure tries to be both ledger and working memory, and it's bad at both:

- As a ledger, it loses entries on overflow → context permanently gone
- As working memory, it carries stale entries the judge shouldn't anchor on

The 2e38d4db FIFO fix is strictly better than the broken sticky-original behaviour, but it still throws away history. A user who says "ok now go back to the auth bug we abandoned earlier" gets nothing — the auth-bug intent has been popped from the stack and there's no record left.

### Real workflows the current model breaks

1. **"Go back to the earlier task"** — User explicitly returns to a prior goal. Today: lost forever once it's pushed off the stack.
2. **Long-running multi-goal sessions** — Software dev sessions interleave many concerns (build feature, fix unrelated bug, review PR, back to feature). Today: the most-recent-N model collapses these into chronological order, dropping the older tracks.
3. **`claude --continue` after a long break** — All prior intents marked `resolved` by Stop hook. Today's classifier might treat a continuation as a new task (high drift) and evict the resolved history including what the user might want to resume.
4. **Sub-task structure** — "build the auth service" → "let me first add tests for the password validator" is a child of the parent goal, not a replacement. Today's flat stack can't express this; eviction can drop the parent before the child completes.

---

## Proposed model

### Per-session state

```typescript
interface SessionIntentState {
  /** Append-only ledger of every intent ever registered. Bounded by
   *  MAX_INTENT_HISTORY (high — say 500) and TTL'd via Dynamo's 30d
   *  item TTL. Entries gain a stable id at registration. */
  intentHistory: IntentEntry[];

  /** Subset of intentHistory by id that is currently "live" — the
   *  set the judge anchors against on /evaluate. Bounded by
   *  MAX_ACTIVE_INTENTS (low — 3 to 5). Ordered: most-recently-
   *  activated last. */
  activeIntentIds: string[];
}
```

`IntentEntry` gets a stable `id` (UUID). All other fields stay (kind, contextual, embedding, registeredAt, resolved, images).

### What the judge sees

Per `/evaluate`, the hook resolves `activeIntentIds` against `intentHistory` and passes the materialised entries to the interceptor:

```typescript
const activeIntents = intentHistory.filter(e => activeIntentIds.includes(e.id));
```

This replaces the current `getActiveIntents` return (which today is the entire stack). The interceptor's contract doesn't change — it still receives a list of `IntentEntry` and does the same multi-goal min-distance similarity comparison.

### Eviction is now two questions

| Question | Answer |
|---|---|
| When does an entry leave **history**? | Only on `MAX_INTENT_HISTORY` overflow (very rare) or 30d TTL. Never deleted as side-effect of new prompts. |
| When does an entry leave **active**? | Frequently. New prompt arrives → classifier decides which existing actives to evict, mark resolved (but kept in history). |

Active eviction is aggressive (3-5 entries kept live so the judge stays focused). History eviction is lazy.

### `/intent` flow under new model

```
on POST /intent(prompt):
  classify_kind(prompt, history, active)  →  {kind, parent_id?, replaces_id?}
  new_entry = {id: uuid(), prompt, embedding, kind, parent_id, replaces_id, ...}
  history.append(new_entry)

  switch (kind):
    case "original":
      active = [new_entry.id]            # session start, only this is live

    case "continuation":
      active = active + [new_entry.id]   # build on existing actives
      # if active exceeds MAX_ACTIVE_INTENTS, drop oldest

    case "sub-task":
      active = active + [new_entry.id]   # child of parent_id; parent stays live

    case "replacement":
      mark replaces_id resolved
      active = (active without replaces_id) + [new_entry.id]

    case "topic-switch":
      mark all current actives resolved
      active = [new_entry.id]

    case "revisit":                      # NEW — user returning to past goal
      revived_id = pick_from_history(prompt, history)
      mark all current actives resolved   # or: keep some, configurable
      active = [revived_id]               # OR [revived_id, new_entry.id]
      mark revived entry not-resolved
```

### Classifier choice for the "kind" decision

Today: heuristic (drift threshold + turnState). Works for the obvious cases (clear topic switch via `closed` + high drift). Misses the nuanced ones (sub-task vs replacement vs revisit).

Three options for the new classifier:

#### Option A — Pure embedding heuristics

Cheapest. Drift-from-active-set is already computed.

| Signal | Decision |
|---|---|
| Prompt similar to last active entry | continuation |
| Prompt similar to a *non-active* historical entry → revisit candidate | revisit |
| Low drift to *no* historical entry → topic-switch (or sub-task) |
| Otherwise | continuation |

Pros: free, fast, deterministic.
Cons: can't tell sub-task from replacement; might mis-classify revisit when the historical entry was about a similar topic but a different instance.

#### Option B — LLM judge per /intent (when ambiguous)

Run the existing intent-judge with a different prompt: "given this history and this new user message, classify as one of {continuation, sub-task, replacement, topic-switch, revisit}, and if revisit/replacement say which existing entry by id."

Pros: best correctness, handles nuance.
Cons: ~$0.005 per call × every UserPromptSubmit on hot path. +1-3s latency on every prompt. Adds another failure mode (judge timeout / classification garbage). Would need confidence thresholds + fallback.

#### Option C — Hybrid (recommended)

Embeddings for the obvious cases (drift > X → topic-switch, drift < Y → continuation). LLM only for ambiguous middle band. Estimated to fire on <30% of prompts based on the current drift distribution.

Pros: best correctness where it matters, ~70% cost reduction vs always-LLM, hot-path latency only impacted when the distinction matters.
Cons: more code paths, two failure modes.

**Recommendation: start with Option A**, ship the data structure change, ship the eviction logic. Add Option C in a follow-up once we have telemetry on how often each path is hit. Don't ship Option B alone — too expensive.

---

## Schema migration

Today's Dynamo `META` item carries `activeIntents: IntentEntry[]`. Need to migrate to:
- `META.intentHistory: IntentEntry[]` — full ledger (with `id` field added)
- `META.activeIntentIds: string[]` — id reference list

Migration strategy:
1. **On read** in `cached-session-store.ts`: if `intentHistory` is absent, treat the existing `activeIntents` as both history and active (give each entry a synthesised id).
2. **On write**: always write the new schema. Old fields can stay populated (deprecated) for one release cycle so a rollback is safe.
3. **Background backfill**: not needed. New schema is built lazily as sessions naturally become active again. Old sessions just stay on the legacy schema until their 30d TTL.

Total migration: zero downtime, zero coordinated rollout. Just a forward-compatible reader.

---

## What the judge prompt sees

Today: the judge's "Recent goals" section is rendered from the materialised stack. With the new model, render the same section from the resolved-active set. **Identical format from the judge's POV** — the judge has no idea history exists.

Optional: include a "background context" section listing recent-but-resolved entries by title only, so the judge can see "you had earlier been working on X, Y" without anchoring on them. Improves classification of follow-ups that reference past work. **Out of scope for v1**; revisit after measuring v1 performance.

---

## Active-set eviction policy

When `kind === "continuation"` or `"sub-task"` causes the active set to exceed `MAX_ACTIVE_INTENTS`:

| Strategy | Pros | Cons |
|---|---|---|
| **FIFO (drop oldest active)** | Simple, deterministic | Can drop a still-relevant parent goal |
| **LRU (drop least-recently-touched)** | Better for nested structure | Needs per-entry "last-touched" timestamp updated on every /evaluate |
| **Drift-aware (drop entry with highest drift to current prompt)** | Keeps still-relevant entries | New prompt could be off-topic AND we drop the wrong thing |

**Recommendation:** **LRU** with a `lastActiveAt` timestamp updated whenever an entry is materialised for `/evaluate`. Naturally keeps in-use parents alive. Touch-on-evaluate (not touch-on-intent) so stale subgoals get evicted while active parents stay.

`MAX_ACTIVE_INTENTS = 5` based on intuition: more than 3 because nested sub-tasks need parent + intermediate + leaf; less than 10 because beyond that the judge gets diluted prompts.

---

## "Revisit" detection

Hardest case — distinguishing "go back to the auth bug" from "let's tackle a new auth bug" requires understanding that a *specific* prior entry is being referenced.

### Signal sources

1. **Phrasing patterns:** "go back to", "return to", "let's resume", "now back to" → strong revisit signal.
2. **Embedding similarity to a non-active historical entry:** the prompt resembles a past goal more than any current active. Suggestive.
3. **LLM judgement:** "is the user continuing an existing goal from history or starting fresh?"

### v1 behaviour

- Detect phrasing patterns + run embedding cosine across full history.
- If a clear historical match (similarity > REVISIT_THRESHOLD) AND phrasing pattern present → revive that entry.
- Otherwise fall back to current heuristics (continuation / topic-switch / etc).
- Confidence threshold: `REVISIT_PHRASING_REQUIRED = true` initially. Revisit only fires when phrasing is explicit. Avoids false-positives where an embedding match suggests revisit but the user actually meant a new related task.

Active set after revisit: `[revived_id, new_entry_id]` (parent + framing). Other actives marked resolved.

---

## API changes

| Method | Today | New |
|---|---|---|
| `tracker.getActiveIntents(sid)` | returns `IntentEntry[]` | returns `IntentEntry[]` (resolved from active id list — caller-transparent change) |
| `tracker.setActiveIntents(sid, list)` | replaces the stack | **deprecated**; use new methods below |
| `tracker.appendToHistory(sid, entry)` | n/a | append to history, return id |
| `tracker.markIntentResolved(sid, ids[])` | n/a | bulk-mark entries resolved (kept in history, removed from active) |
| `tracker.activateIntent(sid, id)` | n/a | add id to active set |
| `tracker.touchActiveIntent(sid, id)` | n/a | bump lastActiveAt for LRU eviction |
| `tracker.getIntentHistory(sid, limit?)` | n/a | full history list |

`setActiveIntents` is kept for the mode-flip path (clears active set) but documented as deprecated for new code.

---

## Implementation plan

### Step 1 — schema + readers (no behaviour change)

- Add `id` field to `IntentEntry` (default: UUID generated at registration).
- Add `intentHistory` and `activeIntentIds` to `SessionState` interface.
- Update `cached-session-store` and `dynamo-session-store` to read/write the new fields. Implement the migration shim.
- All existing call sites still work via `getActiveIntents` / `setActiveIntents`.

**Test:** existing test suite passes unchanged. Round-trip through Dynamo preserves new fields.

### Step 2 — write path: append-only history

- `applyIntentStackUpdate` writes to history first, then derives active.
- Behaviour-equivalent to current code — same eviction outcome, just goes through the new structure.
- `trimStack` becomes `trimActiveSet` (LRU-based on the active subset only). History is left untouched.

**Test:** for any sequence of /intent calls, the materialised stack from `getActiveIntents` matches the current implementation's output.

### Step 3 — new "kind" classifications

- Add `"sub-task"`, `"replacement"`, `"revisit"` to `IntentEntry["kind"]`.
- Embedding-based classifier (Option A from above).
- Revisit detection (phrasing + similarity + threshold).
- Active set updates per kind.

**Test:** scenarios:
- "review markdown plan" → "build feature X" → "back to reviewing the markdown" — revisit fires, active = [markdown_id].
- "build auth" → "first add tests" — sub-task, active = [auth_id, tests_id].
- "fix login bug" → "actually fix logout instead" — replacement, login marked resolved.

### Step 4 — judge prompt + telemetry

- Optional: render kind into the judge's "Recent goals" section so the judge sees parent/child structure.
- Telemetry on classifier outcomes (count by kind per session) for tuning.

### Step 5 — feature flag rollout

- `INTENT_HISTORY_MODE` env: `"legacy" | "history-active"`. Default legacy on first deploy.
- Validate against InjecAgent corpus (single-prompt sessions — should be no-op).
- Validate against AgentDojo (multi-turn sessions).
- Validate against a synthetic "go back" workflow.
- Flip default after 1 week of telemetry.

### Step 6 — cleanup

- Remove legacy `setActiveIntents` direct stack writes from `applyIntentStackUpdate`.
- Drop the migration shim once all sessions in Dynamo have the new schema (≥30d after default flip).

---

## Estimated effort

| Step | Effort |
|---|---|
| 1 — schema + readers | 1 day |
| 2 — write path | 1 day |
| 3 — new kinds + revisit | 2 days (most of the work) |
| 4 — judge + telemetry | 0.5 day |
| 5 — flag rollout | 0.5 day code + 1 week observation |
| 6 — cleanup | 0.5 day |
| **Total** | **~5.5 dev days + 1 week observation** |

---

## Open questions

1. **MAX_ACTIVE_INTENTS value:** 3? 5? More? Needs telemetry on how many goals real users juggle simultaneously.
2. **Should resolved entries appear in the judge prompt as "background"?** Could improve classification of "remember when we…" prompts. Could also dilute the judge's focus. Decide after step 4 telemetry.
3. **Multi-thread sessions:** is "doing two things in parallel" a valid model? Today the stack assumes serial focus. The active set could explicitly support N parallel goals if `MAX_ACTIVE_INTENTS > 1` and we don't auto-evict on continuation.
4. **`/end` semantics in new model:** mark all actives resolved, but keep history. Already aligned with current `/end` behaviour. No change.
5. **`/pivot` semantics:** today drops the stack entirely. New: mark all actives resolved (keep in history), append the new prompt as `original`. Better — the user can revisit pre-pivot work via the revisit mechanism.

---

## Decision points before starting code

- Confirm the `IntentEntry["kind"]` enum addition (`sub-task`, `replacement`, `revisit`).
- Confirm `MAX_ACTIVE_INTENTS` = 5 starting value.
- Confirm Option A (embedding-only classifier) for v1, with Option C (hybrid LLM) deferred.
- Confirm LRU active eviction with `lastActiveAt` timestamp.
- Confirm migration is forward-compat read-only (no batch backfill).
