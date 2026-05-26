# Lightweight `/api/sessions` via META Aggregates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GET /api/sessions` a single cheap GSI query instead of a 50× full-session `buildSessionLogShape` fan-out, by maintaining the list's aggregates on the session META row.

**Architecture:** Add four running aggregates (`aggToolCalls`, `aggDenied`, `aggFiles`, `lastClassification`) to the META row, maintained by atomic `ADD`/`SET` updates folded into the existing `record*` writes on `/track`. Surface them (plus the already-stored `clientIp`/`userPermissions`) through `SessionSummary` + `listSessions`, and rebuild `/api/sessions` as a lightweight projection that never calls `buildSessionLogShape`. The detail view (`/api/session-log/:id`) is unchanged. The UI already degrades gracefully; one tooltip tweak is needed.

**Tech Stack:** TypeScript (ESM, `npx tsx`), DynamoDB (`@aws-sdk/lib-dynamodb`), static HTML/JS dashboard.

**Spec:** `docs/superpowers/specs/2026-05-26-lightweight-sessions-list-design.md`

---

## File Structure

- `src/session-store.ts` — `SessionSummary` interface: +6 optional fields.
- `src/dynamo-session-store.ts` — atomic counter maintenance in `recordToolCall`/`recordFileWrite`/`recordTurnMetrics`; map the new fields in `listSessions`.
- `src/session-tracker.ts` — `InMemorySessionStore.listSessions`: derive the 6 fields from in-memory state.
- `src/server-dashboard.ts` — `/api/sessions`: lightweight projection (pure mapper `sessionListEntry`), drop the `buildSessionLogShape` fan-out.
- `src/web/dashboard.html` — `buildFileTip` count fallback + pass the count from the row.
- `hooks/tests/test_lightweight_sessions.ts` — new `npx tsx` suite.

**META attribute names** (new): `aggToolCalls`, `aggDenied`, `aggFiles`, `lastClassification`. (Named `agg*` to avoid confusion with the per-turn METRIC item's existing `toolCallCount`/`toolCallsDenied`.) `clientIp` and `userPermissions` already exist on META.

**SessionSummary new fields:** `toolCallCount`, `deniedCount`, `fileWriteCount`, `lastClassification`, `clientIp`, `userPermissions` (all optional).

---

## Task 1: Extend `SessionSummary`

**Files:**
- Modify: `src/session-store.ts` (the `SessionSummary` interface, ~line 50)

- [ ] **Step 1: Add the optional fields**

In the `SessionSummary` interface, after `ownerEmail?: string | null;`, add:

```ts
  /** Running aggregates maintained on the session META row so the
   *  dashboard list view renders without a full per-session
   *  reconstruction. Optional + default-0 for back-compat with rows
   *  written before these counters existed. */
  toolCallCount?: number;
  deniedCount?: number;
  fileWriteCount?: number;
  /** Classification of the most recent turn metric (on-task / scope-creep
   *  / drifting / hijacked), or null if no turn metric yet. */
  lastClassification?: string | null;
  /** ALB-observed client IP, copied from META (list IP badge). */
  clientIp?: string | null;
  /** Per-(user,project) Claude Code permission lists copied to META
   *  (list "U" badge). Shape: { allow, deny, ask } string arrays. */
  userPermissions?: { allow?: string[]; deny?: string[]; ask?: string[] } | null;
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep "session-store" || echo clean`
Expected: `clean`

- [ ] **Step 3: Commit**

```bash
git add src/session-store.ts
git commit -m "feat(sessions): SessionSummary aggregate + badge fields"
```

---

## Task 2: Dynamo `listSessions` returns the new fields

**Files:**
- Modify: `src/dynamo-session-store.ts` (`listSessions`, ~line 342-352)
- Test: `hooks/tests/test_lightweight_sessions.ts`

- [ ] **Step 1: Write the failing test**

```ts
// hooks/tests/test_lightweight_sessions.ts
// Run: npx tsx hooks/tests/test_lightweight_sessions.ts
import { DynamoSessionStore } from "../../src/dynamo-session-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

// Minimal fake DynamoDBDocumentClient: records every command and returns
// canned results. Each command class is identified by constructor name.
function fakeClient(opts: { queryItems?: any[]; getItem?: any } = {}) {
  const sent: any[] = [];
  return {
    sent,
    async send(cmd: any) {
      sent.push(cmd);
      const n = cmd.constructor.name;
      if (n === "QueryCommand") return { Items: opts.queryItems ?? [] };
      if (n === "GetCommand") return { Item: opts.getItem };
      return {};
    },
  } as any;
}

async function main() {
  // --- Task 2: listSessions maps META aggregates -> summary fields ---
  const metaRow = {
    sessionId: "s1", sk: "META", startedAt: "t0", endedAt: null,
    originalIntent: { prompt: "do the thing" }, currentTurn: 3,
    hijackStrikes: 0, lockedHijacked: false, ownerSub: "u1", ownerEmail: "u@x",
    aggToolCalls: 7, aggDenied: 2, aggFiles: 4, lastClassification: "drifting",
    clientIp: "1.2.3.4", userPermissions: { allow: ["Read"], deny: [], ask: [] },
  };
  const store = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0",
    client: fakeClient({ queryItems: [metaRow] }),
  });
  const list = await store.listSessions(50);
  const s = list[0];
  ok("toolCallCount from aggToolCalls", s.toolCallCount === 7);
  ok("deniedCount from aggDenied", s.deniedCount === 2);
  ok("fileWriteCount from aggFiles", s.fileWriteCount === 4);
  ok("lastClassification mapped", s.lastClassification === "drifting");
  ok("clientIp mapped", s.clientIp === "1.2.3.4");
  ok("userPermissions mapped", (s.userPermissions?.allow ?? []).length === 1);
  ok("missing aggregates default to 0 / null", (() => {
    return true; // checked in a second store below
  })());

  const store2 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0",
    client: fakeClient({ queryItems: [{ sessionId: "old", sk: "META", startedAt: "t0", currentTurn: 0 }] }),
  });
  const old = (await store2.listSessions(50))[0];
  ok("legacy row: counts default 0", old.toolCallCount === 0 && old.deniedCount === 0 && old.fileWriteCount === 0);
  ok("legacy row: lastClassification null", old.lastClassification === null || old.lastClassification === undefined);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

> Note: confirm the `DynamoSessionStore` constructor accepts `{ tableName, region, embeddingModel, client }` — it follows the same injected-`client` pattern as the other stores. If the option key differs (e.g. `docClient`), adjust the test + later tasks to match the real constructor.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: FAIL — `toolCallCount` is `undefined` (listSessions doesn't map it yet).

- [ ] **Step 3: Map the new fields in `listSessions`**

In `src/dynamo-session-store.ts`, change the `listSessions` return map (~line 342) to add the six fields:

```ts
    return (r.Items ?? []).map((m) => ({
      sessionId: m.sessionId,
      startedAt: m.startedAt ?? null,
      endedAt: m.endedAt ?? null,
      originalTask: (m.originalIntent as any)?.prompt ?? null,
      currentTurn: m.currentTurn ?? 0,
      hijackStrikes: m.hijackStrikes ?? 0,
      lockedHijacked: m.lockedHijacked ?? false,
      ownerSub: m.ownerSub ?? null,
      ownerEmail: m.ownerEmail ?? null,
      toolCallCount: m.aggToolCalls ?? 0,
      deniedCount: m.aggDenied ?? 0,
      fileWriteCount: m.aggFiles ?? 0,
      lastClassification: m.lastClassification ?? null,
      clientIp: m.clientIp ?? null,
      userPermissions: m.userPermissions ?? null,
    }));
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: `ALL PASS (9/9)`

- [ ] **Step 5: Commit**

```bash
git add src/dynamo-session-store.ts hooks/tests/test_lightweight_sessions.ts
git commit -m "feat(sessions): dynamo listSessions returns META aggregates + badges"
```

---

## Task 3: Dynamo `recordToolCall` → atomic `ADD` on META

**Files:**
- Modify: `src/dynamo-session-store.ts` (`recordToolCall`, ~line 1525; add after the TOOL# write)
- Test: extend `hooks/tests/test_lightweight_sessions.ts`

- [ ] **Step 1: Add a write-path assertion to the test**

Append to `main()` before the summary:

```ts
  // --- Task 3: recordToolCall issues an atomic ADD on META ---
  const fc = fakeClient({ getItem: { sessionId: "s2", sk: "META", currentTurn: 1 } });
  const store3 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0", client: fc,
  });
  await store3.recordToolCall("s2", "Bash", { command: "ls" }, "deny", 0.1, "tool_x");
  const updates = fc.sent.filter((c: any) => c.constructor.name === "UpdateCommand"
    && c.input?.Key?.sk === "META");
  const counterUpd = updates.find((u: any) =>
    /ADD/.test(u.input.UpdateExpression) && /aggToolCalls/.test(u.input.UpdateExpression));
  ok("recordToolCall ADDs aggToolCalls on META", !!counterUpd);
  ok("deny also ADDs aggDenied", !!counterUpd && /aggDenied/.test(counterUpd.input.UpdateExpression));
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: FAIL — no META `ADD` update is sent.

- [ ] **Step 3: Add the atomic counter update**

In `recordToolCall`, AFTER the existing TOOL# `PutCommand` (the conditional-put block that persists the tool call) and before the method returns, add:

```ts
    // Maintain session-level aggregates on META for the dashboard list
    // (so /api/sessions needs no per-session reconstruction). Atomic ADD —
    // no read-modify-write race. Best-effort: a counter blip must never
    // break the /track path, so swallow errors like the rest of this method.
    try {
      const addExpr = decision === "deny"
        ? "ADD aggToolCalls :one, aggDenied :one"
        : "ADD aggToolCalls :one";
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: pk(sessionId), sk: "META" },
          UpdateExpression: addExpr,
          ExpressionAttributeValues: { ":one": 1 },
        }),
      );
    } catch (err) {
      console.warn(`  [agg] toolCall counter update failed for ${sessionId}: ${(err as Error)?.message ?? err}`);
    }
```

(`UpdateCommand` is already imported — see line 61.)

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: all prior + the 2 new assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dynamo-session-store.ts hooks/tests/test_lightweight_sessions.ts
git commit -m "feat(sessions): maintain aggToolCalls/aggDenied on META"
```

---

## Task 4: Dynamo `recordFileWrite` → `ADD aggFiles` on a new path

**Files:**
- Modify: `src/dynamo-session-store.ts` (`recordFileWrite`, the `else` branch ~line 1795 where a brand-new `FILE#W#` item is created)
- Test: extend `hooks/tests/test_lightweight_sessions.ts`

- [ ] **Step 1: Add the test**

```ts
  // --- Task 4: recordFileWrite ADDs aggFiles only for a NEW path ---
  // New path: GetCommand(FILE#W) returns no Item -> else branch.
  const fcNew = fakeClient({ getItem: undefined });
  const store4 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0", client: fcNew,
  });
  await store4.recordFileWrite("s3", "/tmp/a.txt", "hello", false);
  const fileAdd = fcNew.sent.find((c: any) => c.constructor.name === "UpdateCommand"
    && c.input?.Key?.sk === "META" && /ADD aggFiles/.test(c.input.UpdateExpression));
  ok("new file path ADDs aggFiles on META", !!fileAdd);

  // Existing path: GetCommand(FILE#W) returns an Item -> if branch, NO aggFiles add.
  const fcExist = fakeClient({ getItem: { path: "/tmp/a.txt", writeCount: 1, sk: "FILE#W#x" } });
  const store5 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0", client: fcExist,
  });
  await store5.recordFileWrite("s3", "/tmp/a.txt", "more", true);
  const fileAdd2 = fcExist.sent.find((c: any) => c.constructor.name === "UpdateCommand"
    && c.input?.Key?.sk === "META" && /ADD aggFiles/.test(c.input.UpdateExpression));
  ok("repeat file path does NOT add aggFiles", !fileAdd2);
```

> Note: the `recordFileWrite` `else` branch also issues a `QueryCommand` for `FILE#R#` (read-first check) — the fake returns `{Items: []}` for queries, which is fine.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: FAIL — "new file path ADDs aggFiles" fails (no such update yet).

- [ ] **Step 3: Add the increment in the new-path branch**

In `recordFileWrite`, inside the `else` block (the path that creates a brand-new `FILE#W#` item — i.e. `existing.Item` was falsy), AFTER that new-item `PutCommand`, add:

```ts
      // First time this path is written this session → bump the distinct
      // file counter on META. Best-effort (see recordToolCall rationale).
      try {
        await this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk: pk(sessionId), sk: "META" },
            UpdateExpression: "ADD aggFiles :one",
            ExpressionAttributeValues: { ":one": 1 },
          }),
        );
      } catch (err) {
        console.warn(`  [agg] file counter update failed for ${sessionId}: ${(err as Error)?.message ?? err}`);
      }
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: both new assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dynamo-session-store.ts hooks/tests/test_lightweight_sessions.ts
git commit -m "feat(sessions): maintain aggFiles (distinct paths) on META"
```

---

## Task 5: Dynamo `recordTurnMetrics` → `SET lastClassification` on META

**Files:**
- Modify: `src/dynamo-session-store.ts` (`recordTurnMetrics`, ~line 1929; after the METRIC# put)
- Test: extend `hooks/tests/test_lightweight_sessions.ts`

- [ ] **Step 1: Add the test**

```ts
  // --- Task 5: recordTurnMetrics SETs lastClassification on META ---
  const fcm = fakeClient({ getItem: { sessionId: "s4", sk: "META", currentTurn: 2 } });
  const store6 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0", client: fcm,
  });
  // driftFromOriginal 0.4 -> classifyDrift -> "drifting" (per tracker thresholds)
  await store6.recordTurnMetrics("s4", 0.4, 0.1, 3, 1, false, false);
  const classUpd = fcm.sent.find((c: any) => c.constructor.name === "UpdateCommand"
    && c.input?.Key?.sk === "META" && /SET lastClassification/.test(c.input.UpdateExpression));
  ok("recordTurnMetrics SETs lastClassification on META", !!classUpd);
  ok("lastClassification value is the derived class", !!classUpd && typeof classUpd.input.ExpressionAttributeValues[":c"] === "string");
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: FAIL — no `SET lastClassification` update.

- [ ] **Step 3: Add the SET**

In `recordTurnMetrics`, AFTER the METRIC# `PutCommand` (the `classification` const is already computed via `this.classifyDrift(driftFromOriginal)`), add:

```ts
    // Mirror the latest classification onto META so the dashboard list
    // can show the badge without reading the METRIC# items. Best-effort.
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: pk(sessionId), sk: "META" },
          UpdateExpression: "SET lastClassification = :c",
          ExpressionAttributeValues: { ":c": classification },
        }),
      );
    } catch (err) {
      console.warn(`  [agg] classification update failed for ${sessionId}: ${(err as Error)?.message ?? err}`);
    }
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: both new assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dynamo-session-store.ts hooks/tests/test_lightweight_sessions.ts
git commit -m "feat(sessions): mirror lastClassification onto META"
```

---

## Task 6: `InMemorySessionStore.listSessions` derives the fields

**Files:**
- Modify: `src/session-tracker.ts` (`InMemorySessionStore.listSessions`, ~line 86)
- Test: extend `hooks/tests/test_lightweight_sessions.ts`

- [ ] **Step 1: Add the test**

```ts
  // --- Task 6: InMemorySessionStore.listSessions derives aggregates ---
  const { InMemorySessionStore } = await import("../../src/session-tracker.js");
  const mem = new InMemorySessionStore("nomic-embed-text");
  await mem.registerIntent("m1", "do a thing");
  await mem.recordToolCall("m1", "Bash", { command: "ls" }, "allow", 0.9, "t1");
  await mem.recordToolCall("m1", "Bash", { command: "rm x" }, "deny", 0.1, "t2");
  await mem.recordFileWrite("m1", "/tmp/x", "hi", false);
  await mem.recordFileWrite("m1", "/tmp/x", "hi2", true);   // same path
  await mem.recordFileWrite("m1", "/tmp/y", "hi", false);   // new path
  const ms = (await mem.listSessions(50)).find((x: any) => x.sessionId === "m1");
  ok("in-memory toolCallCount = 2", ms?.toolCallCount === 2);
  ok("in-memory deniedCount = 1", ms?.deniedCount === 1);
  ok("in-memory fileWriteCount = 2 distinct", ms?.fileWriteCount === 2);
```

> Note: confirm the `InMemorySessionStore` constructor + `registerIntent` method names against the real class (it implements `SessionStore`). Adjust the setup calls (e.g. the intent-registration method) to the real API if they differ; the assertions on `listSessions` are the point.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: FAIL — `toolCallCount` undefined for the in-memory summary.

- [ ] **Step 3: Derive the fields in `listSessions`**

In `src/session-tracker.ts`, find `InMemorySessionStore.listSessions` (~line 86) and add the six fields to each returned summary, derived from the in-memory `session` state:

```ts
      // (inside the .map over sessions, alongside the existing fields)
      toolCallCount: session.toolHistory.length,
      deniedCount: session.toolHistory.filter((t) => t.decision === "deny").length,
      fileWriteCount: session.filesWritten.size,
      lastClassification: session.turnMetrics.length
        ? session.turnMetrics[session.turnMetrics.length - 1].classification
        : null,
      clientIp: session.clientIp ?? null,
      userPermissions: session.userPermissions ?? null,
```

> Match the exact shape of the existing `listSessions` map in this class (field names like `originalTask`, `currentTurn`). Add the six fields to that same returned object.

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: the 3 in-memory assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-tracker.ts hooks/tests/test_lightweight_sessions.ts
git commit -m "feat(sessions): InMemorySessionStore.listSessions derives aggregates"
```

---

## Task 7: `/api/sessions` lightweight projection (drop the fan-out)

**Files:**
- Modify: `src/server-dashboard.ts` (extract a pure `sessionListEntry` mapper; rewrite the `/api/sessions` live-logs block ~line 156-170)
- Test: extend `hooks/tests/test_lightweight_sessions.ts`

- [ ] **Step 1: Add the mapper test**

```ts
  // --- Task 7: sessionListEntry maps a SessionSummary -> lightweight entry ---
  const { sessionListEntry } = await import("../../src/server-dashboard.js");
  const entry = sessionListEntry({
    sessionId: "s9", startedAt: "t0", endedAt: null, originalTask: "fix bug",
    currentTurn: 4, hijackStrikes: 0, lockedHijacked: false,
    ownerSub: "u1", ownerEmail: "u@x",
    toolCallCount: 5, deniedCount: 1, fileWriteCount: 3, lastClassification: "scope-creep",
    clientIp: "9.9.9.9", userPermissions: { allow: ["Read"], deny: [], ask: [] },
  });
  ok("entry.summary.toolCalls", entry.summary.toolCalls === 5);
  ok("entry.summary.denied", entry.summary.denied === 1);
  ok("entry.summary.filesWritten", entry.summary.filesWritten === 3);
  ok("entry.summary.turns = currentTurn", entry.summary.turns === 4);
  ok("entry.turnMetrics carries last classification", entry.turnMetrics[0].classification === "scope-creep");
  ok("entry.clientIp + userPermissions preserved", entry.clientIp === "9.9.9.9" && entry.userPermissions.allow.length === 1);
  ok("entry has NO full toolCalls/filesWritten arrays", entry.toolCalls === undefined && entry.filesWritten === undefined);
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: FAIL — `sessionListEntry` is not exported.

- [ ] **Step 3: Add the exported mapper + use it in the handler**

In `src/server-dashboard.ts`, add a top-level exported function (near the top, after imports):

```ts
import type { SessionSummary } from "./session-store.js";

/** Map a SessionSummary into the lightweight shape the dashboard session
 *  list consumes — counts + last classification + badges, NO full
 *  per-session reconstruction. The full shape is fetched on click via
 *  /api/session-log/:id. Exported for unit testing. */
export function sessionListEntry(s: SessionSummary): Record<string, unknown> {
  return {
    sessionId: s.sessionId,
    originalTask: s.originalTask,
    timestamp: s.startedAt,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    summary: {
      toolCalls: s.toolCallCount ?? 0,
      denied: s.deniedCount ?? 0,
      filesWritten: s.fileWriteCount ?? 0,
      turns: s.currentTurn ?? 0,
    },
    turnMetrics: s.lastClassification ? [{ classification: s.lastClassification }] : [],
    clientIp: s.clientIp ?? null,
    userPermissions: s.userPermissions ?? null,
    ownerSub: s.ownerSub ?? null,
    ownerEmail: s.ownerEmail ?? null,
  };
}
```

Then replace the live-logs fan-out block (the `const liveLogs ... await Promise.all(selected.map(async (s) => { const shape = await buildSessionLogShape(...) ... }))` block) with the lightweight map:

```ts
      const liveLogs: Record<string, unknown>[] = selected.map(sessionListEntry);
      const liveIds = new Set(liveLogs.map((s) => s.sessionId as string));
```

Leave the rest of the handler (the cache check/store from the earlier hotfix, the admin disk-fallback block, and the final `slice(0, 50)` + cache-set + return) UNCHANGED. `buildSessionLogShape` is no longer used by this handler (it remains used by `/api/session-log/:id`).

- [ ] **Step 4: Run to confirm it passes + module loads**

Run: `npx tsx hooks/tests/test_lightweight_sessions.ts`
Expected: the 7 new assertions PASS.

Run: `npx tsx -e "import('./src/server-dashboard.js').then(()=>console.log('dashboard module OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `dashboard module OK`

- [ ] **Step 5: Confirm the fan-out is gone**

Run: `grep -n "buildSessionLogShape" src/server-dashboard.ts`
Expected: only the `/api/session-log/:id` detail handler references it — NOT the `/api/sessions` handler.

- [ ] **Step 6: Commit**

```bash
git add src/server-dashboard.ts hooks/tests/test_lightweight_sessions.ts
git commit -m "feat(sessions): /api/sessions lightweight projection (no buildSessionLogShape fan-out)"
```

---

## Task 8: `buildFileTip` count fallback in the UI

**Files:**
- Modify: `src/web/dashboard.html` (`buildFileTip` function + the row that calls it, ~line 1449)

- [ ] **Step 1: Give `buildFileTip` a count fallback**

Replace the `buildFileTip` function with a version that accepts an optional count and degrades like `buildToolTip`:

```js
    function buildFileTip(files, count) {
      const n = count ?? (Array.isArray(files) ? files.length : 0);
      if (!files || files.length === 0) {
        return n > 0
          ? `<div class="tip-title">${esc(n)} files written (detail not recorded — open the session)</div>`
          : '<div class="tip-title">No Files Written</div>';
      }
      const rows = files
        .map(f => `<div class="tip-item ${f.containsCanary ? 'denied' : 'allowed'}">${esc(f.path)} (${esc(f.writeCount)}x)${f.containsCanary ? ' CANARY' : ''}</div>`)
        .join('');
      return `<div class="tip-title">Files Written</div><div class="tip-list">${rows}</div>`;
    }
```

- [ ] **Step 2: Pass the count from the row**

In the session-row render (~line 1449), change the `buildFileTip` call to pass the count:

```js
            const fileTip = buildFileTip(s.filesWritten, files);
```

(`files` is the local already computed as `s.summary?.filesWritten ?? 0` a few lines above.)

- [ ] **Step 3: Verify the page still serves**

Run: `npx tsx -e "import('./src/server-dashboard.js').then(()=>console.log('ok')).catch(e=>process.exit(1))"`
Expected: `ok`

Run (syntax-check inline scripts): 
```bash
node -e 'const fs=require("fs");const h=fs.readFileSync("src/web/dashboard.html","utf8");const re=/<script\b([^>]*)>([\s\S]*?)<\/script>/gi;let m,bad=0;while((m=re.exec(h))){if(/\bsrc=/.test(m[1]||""))continue;try{new Function(m[2])}catch(e){bad++;console.log("SYNTAX ERR:",e.message)}}console.log(bad?"FAIL":"inline JS OK")'
```
Expected: `inline JS OK`

- [ ] **Step 4: Commit**

```bash
git add src/web/dashboard.html
git commit -m "feat(dashboard): buildFileTip count fallback for lightweight session list"
```

---

## Task 9: Full-suite regression + wrap-up

- [ ] **Step 1: Run the new suite + the dashboard-touching suites**

Run:
```bash
npx tsx hooks/tests/test_lightweight_sessions.ts
npx tsx hooks/tests/test_phase4_pipeline.ts
npx tsc --noEmit 2>&1 | grep -iE "session-store|dynamo-session|session-tracker|server-dashboard" || echo "clean"
```
Expected: `test_lightweight_sessions` ALL PASS; `test_phase4_pipeline` 17 passed; tsc `clean`.

- [ ] **Step 2: Update CLAUDE.md**

Add a one-line note to the Session storage section: META now carries `aggToolCalls`/`aggDenied`/`aggFiles`/`lastClassification` aggregates so `/api/sessions` renders the list without per-session reconstruction (detail view still reconstructs on demand). Commit:

```bash
git add CLAUDE.md
git commit -m "docs(sessions): note META list-aggregates"
```

---

## Self-Review

**Spec coverage:**
- New META aggregates (toolCallCount/deniedCount/fileWriteCount/lastClassification) → Tasks 3, 4, 5 ✓
- clientIp/userPermissions reused on the summary → Tasks 1, 2, 6 ✓
- Write path (atomic ADD/SET, best-effort, hot-path-safe) → Tasks 3, 4, 5 ✓
- Read path (SessionSummary + listSessions, both stores) → Tasks 1, 2, 6 ✓
- `/api/sessions` lightweight, no buildSessionLogShape, keep 5s cache + disk fallback → Task 7 ✓
- Detail view unchanged → Task 7 (grep confirms buildSessionLogShape only in /api/session-log) ✓
- UI graceful + buildFileTip fallback → Task 8 ✓
- Backfill (legacy rows default 0/null) → Task 2 test (legacy row) ✓
- Testing → Tasks 2-8 ✓

**Placeholder scan:** No TBD/TODO. Each code step shows the code; two "confirm the real constructor/method name" notes are verification guidance, not placeholders (the implementer adjusts injected-client/option-key names to the real signatures — the surrounding assertions are concrete).

**Type consistency:** META attrs `aggToolCalls`/`aggDenied`/`aggFiles`/`lastClassification` used consistently (write Tasks 3-5 ↔ read Task 2). `SessionSummary` fields `toolCallCount`/`deniedCount`/`fileWriteCount`/`lastClassification`/`clientIp`/`userPermissions` consistent across Tasks 1, 2, 6, 7. `sessionListEntry` output (`summary.{toolCalls,denied,filesWritten,turns}`, `turnMetrics[].classification`) matches what `dashboard.html` reads (Task 8 context).
