# Admin sets BYOT token on behalf of a user — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dashboard admin view, set/replace, and clear another user's BYOT Bedrock token, with an audit trail disclosed to both the admin and the affected user.

**Architecture:** Parameterize the existing `/api/byot` endpoint to resolve a `targetOwner` (`isAdmin ? requestedSub : self`), mirroring the `/api/approvals/revoke` precedent and reusing the token-safe handler. Audit fields (`setByAdminSub/Email/At`) ride on the existing `ByotConfigRecord` / `ByotConfigStatusView`. Authorization logic is extracted into a pure, unit-tested helper module so the HTTP handler stays thin wiring (no Clerk-mocking needed in tests). The dashboard BYOT tab gains an admin-only panel reusing `/api/keys` for the user picker.

**Tech Stack:** TypeScript (Node, ESM), DynamoDB (`@aws-sdk/lib-dynamodb`), vanilla HTML/JS dashboard, `npx tsx` test runners.

**Spec:** `docs/superpowers/specs/2026-05-27-admin-byot-on-behalf-design.md`

**Conventions for this plan:**
- Tests are standalone `npx tsx` scripts using the repo's `ok(msg, cond)` pattern (see `hooks/tests/test_byot_store.ts`). They are run directly, not via a framework.
- The repo has no `tsc`/build npm script and runs via `tsx` (esbuild transpile, no type-check). To check types on a touched file without drowning in pre-existing errors, use: `npx tsc --noEmit 2>&1 | grep <filename>` and expect **no lines** for that file.
- Commit after each task.

---

### Task 1: Add admin-audit fields to the BYOT record + status view (and Dynamo read)

Adds `setByAdminSub`, `setByAdminEmail`, `setByAdminAt` to the persisted record and the non-sensitive status view. The InMemory store already round-trips any field (spreads `record`); the Dynamo store spreads on write but reconstructs explicitly on read, so `itemToRecord` must learn the new fields. Legacy rows (no fields) must read as `null`.

**Files:**
- Modify: `src/byot/types.ts` (add fields to `ByotConfigRecord` and `ByotConfigStatusView`; add `ByotActor` type)
- Modify: `src/dynamo-byot-store.ts:28-42` (`itemToRecord`)
- Test: `hooks/tests/test_byot_store.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append inside `main()` in `hooks/tests/test_byot_store.ts`, just before the final `console.log(...)` summary line:

```ts
  // --- admin-audit fields round-trip (InMemory) ---
  await store.put({
    ownerSub: "a1", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: "CT", last4: "abcd", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
    setByAdminSub: "admin_1", setByAdminEmail: "admin@x.io", setByAdminAt: "t0",
  });
  const ar = await store.get("a1");
  ok("InMemory round-trips admin-audit fields",
    ar?.setByAdminSub === "admin_1" && ar?.setByAdminEmail === "admin@x.io" && ar?.setByAdminAt === "t0");

  // --- admin-audit fields round-trip (Dynamo) ---
  await dyn.put({
    ownerSub: "d2", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: "CT3", last4: "wxyz", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
    setByAdminSub: "admin_2", setByAdminEmail: "boss@x.io", setByAdminAt: "t7",
  });
  const dar = await dyn.get("d2");
  ok("Dynamo round-trips admin-audit fields",
    dar?.setByAdminEmail === "boss@x.io" && dar?.setByAdminAt === "t7");

  // --- legacy Dynamo row (no admin fields) reads as null ---
  await dyn.put({
    ownerSub: "d3", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: "CT4", last4: "0000", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
  });
  const dlegacy = await dyn.get("d3");
  ok("Dynamo legacy row reads admin fields as null",
    dlegacy?.setByAdminSub === null && dlegacy?.setByAdminEmail === null && dlegacy?.setByAdminAt === null);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_byot_store.ts`
Expected: FAIL — the two "round-trips admin-audit fields" assertions fail (`itemToRecord` drops the unknown fields → `undefined`, and `ar?.setByAdminSub` is `undefined` on the Dynamo path; on InMemory the field survives but the third assertion's `=== null` legacy check fails because `itemToRecord` doesn't coalesce yet). At least the Dynamo round-trip + legacy assertions show `✗`.

- [ ] **Step 3: Add the fields to the types**

In `src/byot/types.ts`, add to `ByotConfigRecord` (after `lastFallbackReason?` on line 42):

```ts
  /** Set when an admin wrote this config on the user's behalf; null when
   *  the user wrote it themselves (user reclaim clears the stamp). */
  setByAdminSub?: string | null;
  setByAdminEmail?: string | null;
  setByAdminAt?: string | null;
```

Add the identical three lines to `ByotConfigStatusView` (after `lastFallbackReason?` on line 56).

Also add this exported type at the end of the file (used by the service + handler in later tasks):

```ts
/** Who an admin write was performed by. Absent ⇒ a self-write. */
export type ByotActor = { adminSub: string; adminEmail: string | null };
```

- [ ] **Step 4: Teach the Dynamo reader the fields**

In `src/dynamo-byot-store.ts`, in `itemToRecord` (inside the returned object, after `lastFallbackReason` on line 40):

```ts
    setByAdminSub: item.setByAdminSub ?? null,
    setByAdminEmail: item.setByAdminEmail ?? null,
    setByAdminAt: item.setByAdminAt ?? null,
```

(The `put` at line 64-69 already spreads `...record`, so writes need no change.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_byot_store.ts`
Expected: PASS — `ALL PASS` with the three new assertions green.

Run: `npx tsc --noEmit 2>&1 | grep -E "types.ts|dynamo-byot-store.ts"`
Expected: no output (no type errors in the touched files).

- [ ] **Step 6: Commit**

```bash
git add src/byot/types.ts src/dynamo-byot-store.ts hooks/tests/test_byot_store.ts
git commit -m "feat(byot): admin-audit fields on ByotConfigRecord + status view"
```

---

### Task 2: Service stamps the actor on write, clears it on self-write

`ByotService.validateAndStore` and `remove` gain an optional `actor`. To unit-test the stamping without calling Bedrock, add an injectable `probe` seam to `ByotServiceOptions` (defaults to the real `probeRegionCapabilities`). `getStatus` returns the new fields.

**Files:**
- Modify: `src/byot/byot-service.ts`
- Test: `hooks/tests/test_byot_pipeline.ts` (extend)

- [ ] **Step 1: Write the failing test**

In `hooks/tests/test_byot_pipeline.ts`, add this import at the top (after the existing imports, line 9):

```ts
import type { ProbeResult } from "../../src/byot/capability-probe.js";
```

Then append inside `main()`, just before the final `console.log(...)` summary line:

```ts
  // --- admin actor stamping (probe injected so no Bedrock call) ---
  const okProbe = async (): Promise<ProbeResult> => ({ ok: true, failures: [] });
  const svc2 = new ByotService({
    store, crypto, models: { judgeModel: "j", embeddingModel: "e" },
    probe: okProbe,
  });

  // Admin writes on behalf of u3 → fields stamped.
  await svc2.validateAndStore("u3", "tok-aaaa", "eu-west-2",
    { adminSub: "admin_9", adminEmail: "admin@x.io" });
  const adminView = await svc2.getStatus("u3");
  ok("admin write stamps setByAdmin* fields",
    adminView.setByAdminSub === "admin_9" &&
    adminView.setByAdminEmail === "admin@x.io" &&
    typeof adminView.setByAdminAt === "string" && adminView.setByAdminAt.length > 0);

  // User later writes their own token (no actor) → stamp cleared.
  await svc2.validateAndStore("u3", "tok-bbbb", "eu-west-2");
  const selfView = await svc2.getStatus("u3");
  ok("self write clears setByAdmin* fields",
    selfView.setByAdminSub === null &&
    selfView.setByAdminEmail === null &&
    selfView.setByAdminAt === null &&
    selfView.last4 === "bbbb");

  // Remove accepts an actor without throwing.
  await svc2.remove("u3", { adminSub: "admin_9", adminEmail: "admin@x.io" });
  ok("remove(actor) deletes the row", (await svc2.getStatus("u3")).configured === false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_byot_pipeline.ts`
Expected: FAIL — `ByotServiceOptions` has no `probe` (TS is stripped at runtime so it's ignored, meaning the *real* probe runs and throws/﻿errs on a fake token), and `validateAndStore` rejects a 4th `actor` arg / doesn't stamp. The new assertions show `✗` (or the script throws from the real probe).

- [ ] **Step 3: Add the probe seam + actor to the service**

In `src/byot/byot-service.ts`:

Add `ByotActor` to the type import (line 4):

```ts
import type { ByotConfigRecord, ByotConfigStatusView, ByotActor } from "./types.js";
```

Add an optional `probe` to `ByotServiceOptions` (after `models` on line 10):

```ts
  /** Override the Bedrock capability probe — for tests. Defaults to the
   *  real probeRegionCapabilities. */
  probe?: typeof probeRegionCapabilities;
```

In `getStatus`, add the three fields to the returned view (after `lastFallbackReason` on line 33):

```ts
      setByAdminSub: r.setByAdminSub ?? null,
      setByAdminEmail: r.setByAdminEmail ?? null,
      setByAdminAt: r.setByAdminAt ?? null,
```

Change `validateAndStore`'s signature (line 40-44) to accept `actor`:

```ts
  async validateAndStore(
    ownerSub: string,
    token: string,
    region: string,
    actor?: ByotActor,
  ): Promise<{ stored: boolean; probe: ProbeResult }> {
    const probe = await (this.opts.probe ?? probeRegionCapabilities)(token, region, this.opts.models);
    if (!probe.ok) return { stored: false, probe };
```

(That replaces the existing `const probe = await probeRegionCapabilities(...)` line — note the variable is still named `probe`.)

In the same method, build the admin stamp and spread it into `record` (the `record` object literal, line 54-66):

```ts
    const adminStamp = actor
      ? { setByAdminSub: actor.adminSub, setByAdminEmail: actor.adminEmail, setByAdminAt: now }
      : { setByAdminSub: null, setByAdminEmail: null, setByAdminAt: null };
    const record: ByotConfigRecord = {
      ownerSub,
      provider: "bedrock-bearer",
      region,
      ciphertext,
      last4: token.slice(-4),
      status: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastValidatedAt: now,
      lastFallbackAt: null,
      lastFallbackReason: null,
      ...adminStamp,
    };
```

Change `remove` (line 72-75) to accept and log the actor:

```ts
  async remove(ownerSub: string, actor?: ByotActor): Promise<void> {
    if (actor) {
      console.log(`[byot] admin ${actor.adminEmail ?? actor.adminSub} removed token for ${ownerSub}`);
    }
    await this.opts.store.delete(ownerSub);
    this.opts.onChange?.(ownerSub);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_byot_pipeline.ts`
Expected: PASS — `ALL PASS`, including the three new assertions.

Run: `npx tsc --noEmit 2>&1 | grep "byot-service.ts"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/byot/byot-service.ts hooks/tests/test_byot_pipeline.ts
git commit -m "feat(byot): service stamps admin actor on write, clears on self-write"
```

---

### Task 3: Authorization helpers — target resolution + known-owner guard

Pure, testable units that the handler will call. `resolveByotTarget` decides who an operation acts on (admins may target another user; everyone else is locked to self). `isKnownKeyOwner` enforces "picker-only" — an admin can only target a user who already has an API key.

**Files:**
- Create: `src/byot/admin-target.ts`
- Test: `hooks/tests/test_byot_admin_target.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `hooks/tests/test_byot_admin_target.ts`:

```ts
// hooks/tests/test_byot_admin_target.ts
// Run: npx tsx hooks/tests/test_byot_admin_target.ts
import { resolveByotTarget, isKnownKeyOwner } from "../../src/byot/admin-target.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  // Non-admin: requested ownerSub is ignored, always self.
  const a = resolveByotTarget({ isAdmin: false, selfSub: "me", requestedSub: "victim" });
  ok("non-admin locked to self", a.targetOwner === "me" && a.actingOnBehalf === false);

  // Admin targeting another user.
  const b = resolveByotTarget({ isAdmin: true, selfSub: "admin", requestedSub: "u1" });
  ok("admin targets requested user", b.targetOwner === "u1" && b.actingOnBehalf === true);

  // Admin with no requested sub → self, not acting on behalf.
  const d = resolveByotTarget({ isAdmin: true, selfSub: "admin", requestedSub: null });
  ok("admin with no target is self", d.targetOwner === "admin" && d.actingOnBehalf === false);

  // Admin requesting their own sub → self (no stamp).
  const e = resolveByotTarget({ isAdmin: true, selfSub: "admin", requestedSub: "admin" });
  ok("admin targeting self is not on-behalf", e.targetOwner === "admin" && e.actingOnBehalf === false);

  // Blank/whitespace requested sub → self.
  const f = resolveByotTarget({ isAdmin: true, selfSub: "admin", requestedSub: "   " });
  ok("blank requested sub falls back to self", f.targetOwner === "admin" && f.actingOnBehalf === false);

  // Known-owner guard against a fake apiKeys store.
  const fakeKeys = {
    async listByOwner(sub: string, _limit?: number) {
      return sub === "known" ? [{ ownerSub: "known" } as any] : [];
    },
  };
  ok("isKnownKeyOwner true for a key owner", (await isKnownKeyOwner(fakeKeys, "known")) === true);
  ok("isKnownKeyOwner false for unknown sub", (await isKnownKeyOwner(fakeKeys, "ghost")) === false);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_byot_admin_target.ts`
Expected: FAIL — `Cannot find module '../../src/byot/admin-target.js'` (the module doesn't exist yet).

- [ ] **Step 3: Create the helper module**

Create `src/byot/admin-target.ts`:

```ts
// src/byot/admin-target.ts
// Authorization helpers for the BYOT endpoints. Pure + small so the HTTP
// handler stays thin wiring and the policy is unit-tested without Clerk.
import type { ApiKeyStore } from "../api-key-store.js";

export interface ResolveByotTargetOpts {
  /** Caller's admin flag (from the verified Clerk principal). */
  isAdmin: boolean;
  /** Caller's own Clerk userId. */
  selfSub: string;
  /** ownerSub the caller asked to act on (query param or body). */
  requestedSub?: string | null;
}

export interface ResolvedByotTarget {
  /** Whose BYOT config the operation acts on. */
  targetOwner: string;
  /** True iff an admin is acting on a DIFFERENT user (⇒ stamp the actor).
   *  Non-admins, and admins targeting themselves, are never on-behalf. */
  actingOnBehalf: boolean;
}

/** Admins may target another user via `requestedSub`; everyone else is
 *  locked to `selfSub`. A blank/whitespace request falls back to self. */
export function resolveByotTarget(o: ResolveByotTargetOpts): ResolvedByotTarget {
  const requested = (o.requestedSub ?? "").trim();
  const targetOwner = o.isAdmin && requested ? requested : o.selfSub;
  return { targetOwner, actingOnBehalf: targetOwner !== o.selfSub };
}

/** True iff `ownerSub` has at least one API key — the "picker-only" guard
 *  so an admin can't seed a config for an arbitrary/typo'd sub. Uses the
 *  owner-indexed query (not the Scan path). */
export async function isKnownKeyOwner(
  apiKeys: Pick<ApiKeyStore, "listByOwner">,
  ownerSub: string,
): Promise<boolean> {
  const keys = await apiKeys.listByOwner(ownerSub, 1);
  return keys.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_byot_admin_target.ts`
Expected: PASS — `ALL PASS (7/7)`.

Run: `npx tsc --noEmit 2>&1 | grep "admin-target.ts"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/byot/admin-target.ts hooks/tests/test_byot_admin_target.ts
git commit -m "feat(byot): target-resolution + known-owner authz helpers"
```

---

### Task 4: Wire `/api/byot` to honor an admin-supplied target

Replace the three method branches in the `/api/byot` handler so each resolves a `targetOwner`, enforces the known-owner guard when acting on behalf, and threads the `actor`. Non-admin behavior is unchanged (locked to self). DELETE learns to parse an optional body leniently.

**Files:**
- Modify: `src/server-dashboard.ts` (imports near line 30-44; handler block lines 480-528)

- [ ] **Step 1: Add the imports**

In `src/server-dashboard.ts`, after the `byotService,` import from `./server-core.js` (line 43 area, inside that import block add nothing there) — add two new import statements after the `clerk-auth.js` import block (around line 50):

```ts
import { resolveByotTarget, isKnownKeyOwner } from "./byot/admin-target.js";
import type { ByotActor } from "./byot/types.js";
```

- [ ] **Step 2: Replace the `/api/byot` handler block**

Replace the entire block from `if (url.pathname === "/api/byot") {` through its closing `}` (currently lines 480-528) with:

```ts
    if (url.pathname === "/api/byot") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;

      // Build the on-behalf actor for write/delete when an admin targets
      // someone else. requireClerkAuth already verified isAdmin.
      const onBehalfActor = (target: { actingOnBehalf: boolean }): ByotActor | undefined =>
        target.actingOnBehalf
          ? { adminSub: principal.userId, adminEmail: principal.email || null }
          : undefined;

      if (req.method === "GET") {
        const target = resolveByotTarget({
          isAdmin: principal.isAdmin,
          selfSub: principal.userId,
          requestedSub: url.searchParams.get("ownerSub"),
        });
        if (target.actingOnBehalf && !(await isKnownKeyOwner(apiKeys, target.targetOwner))) {
          return json(res, 404, { error: "Unknown user" });
        }
        return json(res, 200, await byotService.getStatus(target.targetOwner));
      }

      if (req.method === "POST") {
        // Parse in an inner try so a malformed body NEVER reaches the
        // outer catch's console.error — Node's JSON.parse messages embed
        // a fragment of the raw body, which here could contain a pasted
        // token. Return 400 without logging the body.
        let body: any;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: "Invalid JSON body" });
        }
        const token = String(body.token ?? "").trim();
        const region = String(body.region ?? "").trim();
        if (!token) return json(res, 400, { error: "token is required" });
        if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) {
          return json(res, 400, { error: "valid AWS region is required (e.g. eu-west-2)" });
        }
        const target = resolveByotTarget({
          isAdmin: principal.isAdmin,
          selfSub: principal.userId,
          requestedSub: body.ownerSub,
        });
        if (target.actingOnBehalf && !(await isKnownKeyOwner(apiKeys, target.targetOwner))) {
          return json(res, 404, { error: "Unknown user" });
        }
        let result;
        try {
          result = await byotService.validateAndStore(
            target.targetOwner, token, region, onBehalfActor(target),
          );
        } catch (err) {
          // An unexpected error during the probe (not a probe failure) —
          // never echo the token back.
          return json(res, 502, { error: `validation error: ${(err as Error)?.name ?? "unknown"}` });
        }
        if (!result.stored) {
          return json(res, 400, {
            error: "Token validation failed — the region cannot serve all required models.",
            failures: result.probe.failures, // { model, api, error }[]
          });
        }
        return json(res, 200, await byotService.getStatus(target.targetOwner));
      }

      if (req.method === "DELETE") {
        // Self-serve DELETE sends no body; the admin panel sends { ownerSub }.
        // Parse leniently — a missing/blank/garbage body means "self".
        let delBody: any = {};
        try {
          const raw = await readBody(req);
          if (raw) delBody = JSON.parse(raw);
        } catch {
          /* lenient: treat as self */
        }
        const target = resolveByotTarget({
          isAdmin: principal.isAdmin,
          selfSub: principal.userId,
          requestedSub: delBody.ownerSub,
        });
        if (target.actingOnBehalf && !(await isKnownKeyOwner(apiKeys, target.targetOwner))) {
          return json(res, 404, { error: "Unknown user" });
        }
        await byotService.remove(target.targetOwner, onBehalfActor(target));
        return json(res, 200, { configured: false });
      }

      return json(res, 405, { error: "Method not allowed" });
    }
```

- [ ] **Step 3: Verify types on the touched file**

Run: `npx tsc --noEmit 2>&1 | grep "server-dashboard.ts"`
Expected: no output (no type errors introduced).

- [ ] **Step 4: Re-run the BYOT unit suites (no regressions)**

Run:
```bash
npx tsx hooks/tests/test_byot_store.ts && \
npx tsx hooks/tests/test_byot_pipeline.ts && \
npx tsx hooks/tests/test_byot_admin_target.ts
```
Expected: all three print `ALL PASS`.

- [ ] **Step 5: Smoke-test the wiring locally**

Start the dev server (memory store, no Clerk required for the bind): `npm run server` in one shell. In another:

Run: `curl -s -X POST localhost:3001/api/byot -H 'Content-Type: application/json' -d '{"token":"x","region":"eu-west-2","ownerSub":"someone"}' -i | head -1`
Expected: a `401` (no Clerk token) — confirms the route is reachable and auth-gated. Full on-behalf behavior is exercised by the unit tests in Tasks 2-3 plus the manual dashboard test in Task 5; end-to-end HTTP needs real Clerk tokens and is covered manually.

- [ ] **Step 6: Commit**

```bash
git add src/server-dashboard.ts
git commit -m "feat(byot): /api/byot honors admin-supplied target ownerSub"
```

---

### Task 5: Admin panel on the BYOT tab (user picker + set/clear)

An admin-only section in `#tab-byot`. It builds a user `<select>` from `/api/keys` (deduped by `ownerSub`, labeled by email), loads the selected user's status, and reuses a token+region form to set/replace or remove their token. Uses distinct element IDs (`byot-admin-*`) to avoid colliding with the self form. Gated by the existing `.admin-only` CSS class (hidden for `data-role="user"`) plus a JS `isAdmin` check before any fetch.

**Files:**
- Modify: `src/web/dashboard.html` (HTML in `#tab-byot` after line 762; JS after `saveBYOT()` near line 2698; `loadByot()` near line 2598)

- [ ] **Step 1: Add the admin panel HTML**

In `src/web/dashboard.html`, insert this block between the close of the self `max-width:620px` div (line 762 `</div>`) and the close of `#tab-byot` (line 763 `</div>`):

```html
        <div class="admin-only" style="max-width:620px;margin-top:32px;border-top:1px solid var(--border);padding-top:24px">
          <h2 style="margin:0 0 4px">Admin — set a token for another user</h2>
          <p class="muted" style="margin:0 0 16px;font-size:13px">
            Select a user and configure their Bedrock token on their behalf.
            The user is shown that an administrator set it.
          </p>
          <div style="margin-bottom:16px">
            <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:4px">User</label>
            <select id="byot-admin-user" onchange="renderAdminByot()"
                    style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:13px;font-family:inherit;width:100%">
              <option value="">— select a user —</option>
            </select>
          </div>
          <div id="byot-admin-status" style="margin-bottom:16px"></div>
          <div id="byot-admin-form" style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;display:none">
            <div style="font-weight:600;font-size:14px;margin-bottom:12px">Configure token for selected user</div>
            <div style="margin-bottom:12px">
              <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:4px">Bedrock API key</label>
              <input type="password" id="byot-admin-token" autocomplete="off" placeholder="paste the user's Bedrock bearer token"
                     style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:13px;font-family:inherit">
            </div>
            <div style="margin-bottom:16px">
              <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:4px">AWS region</label>
              <select id="byot-admin-region"
                      style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:13px;font-family:inherit;width:100%">
                <option value="eu-west-2">eu-west-2 (London)</option>
                <option value="eu-west-1">eu-west-1 (Ireland)</option>
                <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                <option value="us-east-1">us-east-1 (N. Virginia)</option>
                <option value="us-west-2">us-west-2 (Oregon)</option>
              </select>
            </div>
            <div style="display:flex;gap:12px;align-items:center">
              <button class="refresh-btn" id="byot-admin-save" onclick="saveAdminByot()" style="font-size:14px">Validate &amp; save for user</button>
              <span id="byot-admin-msg" style="font-size:13px;color:var(--muted)"></span>
            </div>
          </div>
        </div>
```

- [ ] **Step 2: Have `loadByot()` also populate the admin list**

Replace `loadByot()` (lines 2598-2600) with:

```js
    async function loadByot() {
      await renderByot();
      if (dreddPrincipal && dreddPrincipal.isAdmin) await loadByotUserList();
    }
```

- [ ] **Step 3: Add the admin JS functions**

Insert these functions immediately after `saveBYOT()` closes (after line 2698, before `async function loadLogs()`):

```js
    async function loadByotUserList() {
      const sel = document.getElementById('byot-admin-user');
      if (!sel) return;
      try {
        const r = await dreddFetch(`${API}/api/keys`);
        if (!r.ok) return;
        const keys = await r.json();
        const seen = new Set();
        const users = [];
        for (const k of keys) {
          if (!k.ownerSub || seen.has(k.ownerSub)) continue;
          seen.add(k.ownerSub);
          users.push({ ownerSub: k.ownerSub, email: k.ownerEmail || '' });
        }
        users.sort((a, b) => (a.email || a.ownerSub).localeCompare(b.email || b.ownerSub));
        sel.innerHTML = '<option value="">— select a user —</option>' +
          users.map(u => `<option value="${esc(u.ownerSub)}">${esc(u.email || '(no email)')} — ${esc(u.ownerSub.slice(0, 12))}…</option>`).join('');
      } catch (e) { /* leave list as-is on error */ }
    }

    async function renderAdminByot() {
      const sub = document.getElementById('byot-admin-user').value;
      const statusEl = document.getElementById('byot-admin-status');
      const formEl = document.getElementById('byot-admin-form');
      const msgEl = document.getElementById('byot-admin-msg');
      if (msgEl) msgEl.textContent = '';
      if (!sub) { statusEl.innerHTML = ''; formEl.style.display = 'none'; return; }
      formEl.style.display = 'block';
      try {
        const r = await dreddFetch(`${API}/api/byot?ownerSub=${encodeURIComponent(sub)}`);
        if (!r.ok) {
          statusEl.innerHTML = `<div style="color:var(--red);font-size:13px">Failed to load status (HTTP ${r.status})</div>`;
          return;
        }
        const s = await r.json();
        if (!s.configured) {
          statusEl.innerHTML = `<div style="font-size:13px;color:var(--muted);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px">This user has no token configured.</div>`;
          return;
        }
        const managed = s.setByAdminEmail
          ? `<tr><td style="color:var(--muted)">Managed by</td><td class="muted">${esc(s.setByAdminEmail)}${s.setByAdminAt ? ' on ' + esc(new Date(s.setByAdminAt).toLocaleString()) : ''}</td></tr>`
          : '';
        statusEl.innerHTML = `
          <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:12px">
            <table style="margin:0">
              <tr><td style="width:140px;color:var(--muted)">Region</td><td>${esc(s.region ?? '—')}</td></tr>
              <tr><td style="color:var(--muted)">Token</td><td class="mono">••••${esc(s.last4 ?? '')}</td></tr>
              <tr><td style="color:var(--muted)">Status</td><td>${esc(s.status ?? '—')}</td></tr>
              ${managed}
            </table>
          </div>
          <button class="refresh-btn" id="byot-admin-remove" style="font-size:13px;border:1px solid var(--red);color:var(--red)">Remove this user's token</button>`;
        document.getElementById('byot-admin-remove').addEventListener('click', () => removeAdminByot(sub));
      } catch (e) {
        statusEl.innerHTML = `<div style="color:var(--red);font-size:13px">Failed: ${esc(e.message)}</div>`;
      }
    }

    async function saveAdminByot() {
      const sub = document.getElementById('byot-admin-user').value;
      const tokenEl = document.getElementById('byot-admin-token');
      const token = tokenEl.value.trim();
      const region = document.getElementById('byot-admin-region').value;
      const msgEl = document.getElementById('byot-admin-msg');
      const btn = document.getElementById('byot-admin-save');
      if (!sub) { msgEl.style.color = 'var(--red)'; msgEl.textContent = 'Select a user first.'; return; }
      if (!token) { msgEl.style.color = 'var(--red)'; msgEl.textContent = "Paste the user's token first."; return; }
      btn.disabled = true;
      msgEl.style.color = 'var(--muted)';
      msgEl.textContent = 'Validating against the region…';
      try {
        const r = await dreddFetch(`${API}/api/byot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, region, ownerSub: sub }),
        });
        const data = await r.json();
        if (!r.ok) {
          const detail = (data.failures || []).map(f => `${esc(f.model)} (${esc(f.api)}): ${esc(f.error)}`).join('; ');
          msgEl.style.color = 'var(--red)';
          msgEl.textContent = (data.error || 'Validation failed') + (detail ? ' — ' + detail : '');
        } else {
          tokenEl.value = '';
          msgEl.style.color = 'var(--green)';
          msgEl.textContent = 'Saved for user.';
          await renderAdminByot();
        }
      } catch (e) {
        msgEl.style.color = 'var(--red)';
        msgEl.textContent = 'Request failed: ' + e.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function removeAdminByot(sub) {
      if (!confirm("Remove this user's Bedrock token? Their sessions revert to the platform account.")) return;
      try {
        const r = await dreddFetch(`${API}/api/byot`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ownerSub: sub }),
        });
        if (!r.ok) { alert('Remove failed: HTTP ' + r.status); return; }
        await renderAdminByot();
      } catch (e) { alert('Remove failed: ' + e.message); }
    }
```

- [ ] **Step 4: Manual verification**

The dashboard is static HTML served by the dashboard role; verify in a browser against a deployment where you can sign in as an admin (or a local dashboard with Clerk configured):
1. As an **admin**, open the BYOT tab → the "Admin — set a token for another user" panel is visible; the user dropdown is populated with emails.
2. Select a user with no token → "This user has no token configured" + the form appears.
3. Set a (valid) token+region → "Saved for user."; the status shows region/last4/status + a "Managed by `<your email>` on `<date>`" row.
4. Click "Remove this user's token" → confirms, then status returns to "no token configured".
5. As a **non-admin**, open the BYOT tab → the admin panel is **not** visible (CSS `.admin-only` hidden under `data-role="user"`).

- [ ] **Step 5: Commit**

```bash
git add src/web/dashboard.html
git commit -m "feat(byot): admin panel on BYOT tab — pick user, set/clear token"
```

---

### Task 6: User-side disclosure of an admin-set token

On a user's own BYOT tab, when the status carries `setByAdminEmail`, show a note that an administrator configured the token. The user's existing replace/remove controls are unchanged (replacing clears the stamp via the self-write path from Task 2).

**Files:**
- Modify: `src/web/dashboard.html` (`renderByot()`, the configured-status branch near lines 2619-2641)

- [ ] **Step 1: Build the admin note and render it**

In `renderByot()`, immediately after the `fallbackBanner` const (after line 2626) add:

```js
        const adminNote = s.setByAdminEmail
          ? `<div style="background:rgba(56,139,253,0.10);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:12px;font-size:13px;color:var(--muted)">
              This token was configured by an administrator (${esc(s.setByAdminEmail)})${s.setByAdminAt ? ' on ' + esc(new Date(s.setByAdminAt).toLocaleString()) : ''}. You can replace or remove it at any time.
            </div>`
          : '';
```

Then change the `statusEl.innerHTML = \`` opening (line 2631-2632) so the note renders after the fallback banner — replace:

```js
        statusEl.innerHTML = `
          ${fallbackBanner}
```

with:

```js
        statusEl.innerHTML = `
          ${fallbackBanner}
          ${adminNote}
```

- [ ] **Step 2: Manual verification**

In a browser signed in as a **non-admin** whose token was set by an admin in Task 5:
1. Open the BYOT tab → the status shows the "This token was configured by an administrator (`<email>`) on `<date>`" note.
2. Replace the token via the existing self form → after save, the note disappears (self-write cleared the stamp).

- [ ] **Step 3: Commit**

```bash
git add src/web/dashboard.html
git commit -m "feat(byot): disclose admin-set token on the user's own BYOT tab"
```

---

## Self-Review

**Spec coverage:**
- Endpoint parameterization (`targetOwner`, non-admin ignored) → Task 3 (`resolveByotTarget`) + Task 4 (wiring). ✓
- Known-owner 404 guard, off the Scan path → Task 3 (`isKnownKeyOwner` via `listByOwner`) + Task 4. ✓
- Picker from `/api/keys` (email-labeled, deduped) → Task 5 (`loadByotUserList`). ✓
- Audit fields on record + status view → Task 1; stamped/cleared by service → Task 2. ✓
- Admin view+set+clear → Task 5 (renderAdminByot/saveAdminByot/removeAdminByot). ✓
- User-side disclosure + reclaim clears stamp → Task 6 (note) + Task 2 (self-write nulls fields). ✓
- Token never logged/echoed → Task 4 reuses the inner-try POST parse; status view is ciphertext-free (Task 2 returns only `last4`/region/etc.). ✓
- Probe unchanged behavior; partial failure returns `failures` → Task 4 preserves the existing `!result.stored` branch. ✓
- Two-container cache caveat → unchanged (no code touches the hook resolver); documented in spec, nothing to implement. ✓

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to". Every code step shows complete code. ✓

**Type consistency:** `ByotActor = { adminSub, adminEmail }` defined in Task 1, consumed in Task 2 (`validateAndStore`/`remove`) and Task 4 (`onBehalfActor`). `resolveByotTarget`/`isKnownKeyOwner` signatures defined in Task 3 match their calls in Task 4. Status fields `setByAdminSub/Email/At` named identically across types (Task 1), service (Task 2), handler/UI (Tasks 4-6). Element IDs `byot-admin-{user,status,form,token,region,save,msg,remove}` are consistent between the HTML (Task 5 Step 1) and JS (Task 5 Step 3). ✓
