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

**Decision (2026-05-12):** Option B with **async classification**. Embeddings on short conversational prompts ("ok back to that", "do the other thing", "fix it") are exactly the inputs we can't trust them on, and these are the cases where mis-classification has the highest user impact. We accept the cost in exchange for correctness on real human use cases.

#### Option A — Pure embedding heuristics (rejected)

Cheapest. Drift-from-active-set is already computed.

Cons that disqualify it for human conversational input:
- Short prompts ("yes", "back", "do that one") have low-information embeddings — cosine similarity to anything is noisy.
- "Go back to the auth bug" and "let's tackle a new auth bug" produce nearly-identical embeddings — but the correct classifications (revisit vs new-task) are opposite.
- Embedding models pre-date the session's vocabulary; project-specific terminology can lead to spurious similarity.

#### Option B — LLM classifier per /intent (chosen)

Run a dedicated intent-classification prompt against Bedrock Claude Sonnet 4.6: "given this history and this new user message, classify as one of {continuation, sub-task, replacement, topic-switch, revisit}, and if revisit/replacement say which existing entry by id."

**Cost analysis (2026-05-12):**

| Item | Tokens | Notes |
|---|---|---|
| System prompt + format | ~650 | cacheable across session |
| Active intent set (≤5) + recent history (≤10) | ~1,500 | refreshes per session |
| New user prompt | ~150 | per call |
| Total input | ~2,300 | |
| Output (JSON verdict) | ~75 | |

Bedrock Sonnet 4.6 (eu-west-2): input $3 / 1M, output $15 / 1M. **Per call (steady-state with caching): ~$0.0063.**

| Scope | Cost |
|---|---|
| Per session (10 prompts) | $0.063 |
| Per active user / month (660 prompts) | $4.16 |
| 200 active users / month | $832 |
| 1,000 active users / month | $4,160 |

Comparison: existing Stage 3 `/evaluate` LLM judge costs ~$0.005 × ~30 calls/session = $0.15 per session. The intent classifier adds **~42% on top** of current judge spend, not a 10× explosion.

#### Option C — Hybrid embedding + LLM (rejected)

Embeddings for obvious cases, LLM for ambiguous middle band. ~70% cost reduction vs Option B.

Cons that disqualify it: relies on embedding accuracy for the "obvious" cases. Short conversational prompts are exactly where embeddings are unreliable, so the hybrid would silently mis-classify the cases the LLM was supposed to catch.

#### Async classification — making Option B viable on the hot path

The Bedrock round-trip is 1.5–2.5s. Adding that to every UserPromptSubmit before the agent starts processing would be unacceptable user-visible latency.

**The flow:**

```
on POST /intent(prompt):
  // Synchronous: fast bookkeeping
  embedding = embed(prompt)                         // ~100ms (Cohere via Bedrock)
  history.append(temp_entry{id, prompt, embedding, kind: "pending"})

  // Synchronous embedding-based provisional classification.
  // This becomes the FALLBACK if the LLM never returns or arrives
  // after the active set has already been used by /evaluate.
  embedding_kind = classify_via_embedding(prompt, history, active)
  active = apply_active_set_change_for_kind(embedding_kind, history, active)
  temp_entry.kind = embedding_kind   // marked provisional via temp_entry.classifierSource = "embedding"
  return /intent response immediately                // <200ms total

  // Async: kick off LLM classifier, don't block response
  spawn classify_async(prompt, history, active, temp_entry.id):
    verdict = await llm_classify(prompt, history, active)   // 1.5–2.5s
    if verdict.kind != temp_entry.kind:
      // LLM disagrees with the embedding fallback — overwrite kind and
      // reapply the active-set change. Mark classifierSource = "llm".
      update_intent_kind(temp_entry.id, verdict.kind)
      apply_active_set_change(verdict)              // mark resolved, evict, etc
    else:
      // LLM confirmed embedding's guess. Just upgrade classifierSource.
      mark_classifier_source(temp_entry.id, "llm-confirmed")
```

**Why embedding-fallback rather than optimistic-continuation:**

- "Continuation" is only the right default ~60% of the time. Defaulting to it under-counts topic switches and revisits, leaving the judge anchored on stale goals during the 1.5–2.5s classifier window.
- The embedding heuristic, while imperfect on short prompts, gives a *better-than-coin-flip* fallback that catches the obvious cases (very high drift → topic switch; near-identical to last entry → continuation). Mis-classifies the ambiguous middle band — but that's exactly where the LLM will overrule it within ~2s.
- Cost is identical (the embedding is already computed for the entry's `embedding` field).
- Failure mode is graceful: Bedrock outage → embedding-only classification (Option A behaviour) for the duration. We don't fall back to a worse model than Option A would have given us.

**Race condition handling:**

1. **What if `/evaluate` fires before the classifier returns?** The first tool call after a UserPromptSubmit happens within ~1–3s typically — sometimes inside the classifier window. The active set is built from the embedding-fallback classification, so:
   - **Embedding agreed with what LLM will say (~70% of cases):** judge sees correct active set. No harm done.
   - **Embedding mis-classified, LLM will override:** judge briefly sees a slightly-wrong active set. When the LLM verdict lands, the next `/evaluate` sees the corrected state. Window of risk is ~1–2 seconds, ~30% of prompts. The risk is bounded — embedding fallback is a real classification, not "continuation by default", so it usually has *some* reasonable active set even when wrong.

2. **Mitigation: bounded wait at /evaluate boundary.** If the first `/evaluate` for a session arrives while a classifier is in-flight for that session, wait up to **750ms** for it. If still not back, proceed with the embedding-fallback active set. 750ms is below typical agent-response latency so it's hidden in normal flow; it covers most classifier round-trips when Bedrock is warm.

3. **Mitigation: confidence-aware eviction.** If the classifier has high confidence on topic-switch / revisit, immediately mutate the active set and let the next `/evaluate` see correct state. If low confidence, defer to the embedding fallback's existing decision (no overwrite). Confidence comes from the LLM's structured output (a `confidence: "high" | "medium" | "low"` field). Low-confidence overrides would just churn the active set without clear benefit.

4. **Mitigation: telemetry on the race AND on disagreement.** Log:
   - every case where a classifier verdict arrived AFTER its session had `/evaluate` calls (the race window)
   - every case where the LLM verdict differs from the embedding fallback (calibrates how often embeddings get it wrong)
   - every case where the LLM never returned within the timeout (Bedrock degradation indicator)

   If race events are rare (<5%), no further mitigation needed. If common, dial down the wait threshold or pre-warm the classifier on session creation. Disagreement rate informs whether a future hybrid (Option C-like) is viable.

**Failure modes:**

| Failure | Behaviour |
|---|---|
| Classifier times out (>15s soft cap, 30s hard cap) | Embedding fallback wins. Mark `classifierSource = "embedding-fallback-timeout"`. Don't degrade UX. |
| Classifier returns malformed JSON | Embedding fallback wins. Log warning with raw output. Don't degrade UX. |
| Bedrock outage | Embedding fallback wins for all sessions until recovery. Equivalent to Option A behaviour. Acceptable degradation. |
| Race: classifier verdict arrives during /evaluate | If LLM agrees with embedding: no-op. If LLM overrules with high confidence: mutate active set, next `/evaluate` sees corrected state. |

**Implementation pieces:**

- New module `src/intent-classifier.ts` — symmetric to `intent-judge.ts`. System prompt + parser for the kind verdict.
- `applyIntentStackUpdate` becomes synchronous (optimistic) and returns immediately.
- New `classifyIntentAsync` runs after the response is sent. Holds an in-memory map `pendingClassifications: Map<sessionId, Promise<Verdict>>`.
- `/evaluate` checks for pending classification on its session, awaits with 750ms timeout if present.
- `/end` cancels any in-flight classification for the session (no point classifying a closed session).

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

### Step 3 — embedding-fallback classifier (synchronous)

- Add `"sub-task"`, `"replacement"`, `"revisit"` to `IntentEntry["kind"]`.
- Synchronous embedding-based classifier — runs inside `/intent`, gives a provisional kind. This becomes the FALLBACK if the async LLM never returns or arrives late.
- Active set updates per kind.
- Mark each entry's `classifierSource` field: `"embedding"` initially.

**Test:** scenarios with embedding-only behaviour:
- "review markdown plan" → "build feature X" → "back to reviewing the markdown" — revisit fires when phrasing pattern matches AND embedding cosine to historical entry exceeds REVISIT_THRESHOLD.
- "build auth" → "first add tests" — sub-task or continuation depending on drift.
- "fix login bug" → "actually fix logout instead" — likely classified as continuation by embedding (wrong); LLM will overrule in step 4.

### Step 4 — async LLM classifier (the chosen path)

- New module `src/intent-classifier.ts` symmetric to `intent-judge.ts`.
- System prompt + structured-output schema with `kind`, optional `referenced_entry_id`, `confidence: "high" | "medium" | "low"`.
- `classifyIntentAsync(sessionId, prompt, history, active)` runs after `/intent` returns the response.
- In-memory `pendingClassifications: Map<sessionId, Promise<Verdict>>` so `/evaluate` can wait on it with a 750ms cap.
- On verdict: if differs from embedding-fallback AND confidence is high → mutate active set, mark `classifierSource = "llm"`. If matches → mark `classifierSource = "llm-confirmed"`. If low confidence → no-op (defer to embedding fallback).
- `/evaluate` looks up the pending promise; awaits up to 750ms; falls back to current active state on timeout.
- `/end` cancels any in-flight classification for the session.

**Test:** scenarios where LLM should overrule embedding:
- "fix login bug" → "actually fix logout instead" — LLM classifies as replacement, marks login resolved, active becomes [logout_id]. Embedding alone would have classified as continuation.
- "ok back to that one" — LLM detects revisit phrasing + history scan, picks the entry being referenced. Embedding alone has no signal.
- Bedrock returns malformed JSON — embedding fallback persists, log warning.
- Bedrock outage — embedding fallback for all sessions, telemetry records the degradation period.

### Step 5 — judge prompt + telemetry

- Render kind into the judge's "Recent goals" section so the judge sees parent/child structure (e.g. `[parent: build auth] -> [sub-task: add tests]`).
- Telemetry: emit one event per classification with kind, classifierSource, confidence, embedding-vs-LLM-disagreement, latency.
- Dashboard panel: per-session classification timeline; aggregate disagreement rate.

### Step 6 — feature flag rollout

- `INTENT_HISTORY_MODE` env: `"legacy" | "history-active"`. Default legacy on first deploy.
- `INTENT_CLASSIFIER_LLM_ENABLED` env: gate the async LLM path independently. Default false on initial rollout — get the schema + embedding-fallback in production first, then flip the LLM flag.
- Validate against InjecAgent corpus (single-prompt sessions — should be no-op; classifier never runs because session ends after one prompt).
- Validate against AgentDojo (multi-turn sessions).
- Validate against a synthetic "go back" workflow.
- Stage rollout: schema → embedding fallback → async LLM, each behind its own flag.
- Flip defaults after 1 week of telemetry per stage.

### Step 7 — cleanup

- Remove legacy `setActiveIntents` direct stack writes from `applyIntentStackUpdate`.
- Drop the migration shim once all sessions in Dynamo have the new schema (≥30d after default flip).

---

## Estimated effort

| Step | Effort |
|---|---|
| 1 — schema + readers | 1 day |
| 2 — write path | 1 day |
| 3 — embedding-fallback classifier (new kinds) | 1.5 days |
| 4 — async LLM classifier + race handling | 2 days |
| 5 — judge prompt + telemetry | 1 day |
| 6 — flag rollout | 0.5 day code + 1 week observation per stage (3 stages) |
| 7 — cleanup | 0.5 day |
| **Total** | **~7 dev days + 3 weeks observation** |

---

## Open questions

1. **MAX_ACTIVE_INTENTS value:** 3? 5? More? Needs telemetry on how many goals real users juggle simultaneously.
2. **Should resolved entries appear in the judge prompt as "background"?** Could improve classification of "remember when we…" prompts. Could also dilute the judge's focus. Decide after step 4 telemetry.
3. **Multi-thread sessions:** is "doing two things in parallel" a valid model? Today the stack assumes serial focus. The active set could explicitly support N parallel goals if `MAX_ACTIVE_INTENTS > 1` and we don't auto-evict on continuation.
4. **`/end` semantics in new model:** mark all actives resolved, but keep history. Already aligned with current `/end` behaviour. No change.
5. **`/pivot` semantics:** today drops the stack entirely. New: mark all actives resolved (keep in history), append the new prompt as `original`. Better — the user can revisit pre-pivot work via the revisit mechanism.

---

## Decision points before starting code

- ✅ **Decided 2026-05-12:** `IntentEntry["kind"]` adds `sub-task`, `replacement`, `revisit`.
- ✅ **Decided 2026-05-12:** `MAX_ACTIVE_INTENTS` = 5 starting value.
- ✅ **Decided 2026-05-12:** Option B (LLM classifier per /intent) with **async dispatch** and **embedding-fallback**. Embedding accuracy on short conversational prompts is unreliable for the specific cases (revisit detection, sub-task vs replacement) where classification matters most.
- ✅ **Decided 2026-05-12:** Active eviction is LRU with `lastActiveAt` updated on each `/evaluate` materialisation.
- ✅ **Decided 2026-05-12:** Migration is forward-compat read-only. No batch backfill.

Open / pending:
- Telemetry budget — once steps 1-2 are in production, measure embedding-vs-LLM disagreement rate on real sessions to validate the cost/correctness assumption.
- Revisit phrasing pattern set — start with explicit triggers ("go back", "return to", "let's resume", "back to that"). Expand based on telemetry of false-negatives.
- Multi-active interaction with the judge — confirm the interceptor's existing min-distance-over-stack semantics work as intended for parallel goals (it should — already used in interactive mode).
