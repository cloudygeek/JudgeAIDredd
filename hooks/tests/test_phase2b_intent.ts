/**
 * Phase 2b integration test — exercises the InMemory user-permissions
 * store + session-store wiring without booting a real HTTP server.
 *
 * Asserts:
 *   1. upsert(...) then get(...) round-trips via InMemoryUserPermissionsStore
 *   2. SessionStore.setUserPermissions persists; getUserPermissions reads back
 *   3. The (ownerSub, projectRoot) key is stable across calls
 *   4. Independent (ownerSub, projectRoot) keys don't collide
 *
 * Run: npx tsx hooks/tests/test_phase2b_intent.ts
 * Exits non-zero on any failure.
 */

import {
  InMemoryUserPermissionsStore,
  projectRootKey,
} from "../../src/user-permissions-store.js";
import { InMemorySessionStore } from "../../src/session-tracker.js";
import type { UserPermissionsLists } from "../../src/session-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const eq = <T>(a: T, b: T, m: string) => a === b ? pass(m) : fail(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const deepEq = <T>(a: T, b: T, m: string) => JSON.stringify(a) === JSON.stringify(b) ? pass(m) : fail(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

async function main() {
  console.log("\n--- UserPermissionsStore (in-memory) ---");

  const store = new InMemoryUserPermissionsStore();

  // Initial miss.
  eq(await store.get("user-a", "/proj/foo"), null, "empty store returns null");

  // Upsert + round-trip.
  const snapshot = await store.upsert({
    ownerSub: "user-a",
    projectRoot: "/proj/foo",
    hash: "h1",
    allow: ["Bash(awk:*)"],
    deny: ["Bash(curl:*)"],
    ask: [],
  });
  eq(snapshot.hash, "h1", "upsert returns the hash we sent");
  eq(typeof snapshot.updatedAt, "string", "upsert stamps updatedAt");

  const got = await store.get("user-a", "/proj/foo");
  if (!got) { fail("re-get after upsert returned null"); }
  else {
    eq(got.hash, "h1", "get returns same hash");
    deepEq(got.allow, ["Bash(awk:*)"], "get returns same allow list");
    deepEq(got.deny, ["Bash(curl:*)"], "get returns same deny list");
  }

  // Distinct user → no collision.
  eq(await store.get("user-b", "/proj/foo"), null, "different ownerSub does not collide");

  // Distinct project → no collision.
  eq(await store.get("user-a", "/proj/bar"), null, "different projectRoot does not collide");

  // Update existing row replaces lists.
  await store.upsert({
    ownerSub: "user-a",
    projectRoot: "/proj/foo",
    hash: "h2",
    allow: ["Bash(npm:*)"],
    deny: [],
    ask: ["Bash(rm:*)"],
  });
  const updated = await store.get("user-a", "/proj/foo");
  if (!updated) fail("post-update get returned null");
  else {
    eq(updated.hash, "h2", "hash updates");
    deepEq(updated.allow, ["Bash(npm:*)"], "allow replaced");
    deepEq(updated.ask, ["Bash(rm:*)"], "ask replaced");
  }

  // Stable hashing — same path → same key.
  const k1 = projectRootKey("/proj/foo");
  const k2 = projectRootKey("/proj/foo");
  eq(k1, k2, "projectRootKey is stable");
  const k3 = projectRootKey("/proj/bar");
  if (k1 !== k3) pass("projectRootKey differs across paths");
  else fail("projectRootKey collision across paths");

  console.log("\n--- SessionStore.setUserPermissions / getUserPermissions ---");

  const sessions = new InMemorySessionStore();
  const sid = "sess-abc";

  eq(await sessions.getUserPermissions(sid), null, "fresh session returns null");

  const lists: UserPermissionsLists = {
    hash: "h1",
    allow: ["Bash(awk:*)"],
    deny: [],
    ask: [],
    copiedAt: new Date().toISOString(),
  };
  await sessions.setUserPermissions(sid, lists);
  const back = await sessions.getUserPermissions(sid);
  deepEq(back, lists, "set then get returns identical snapshot");

  // Second set replaces.
  const lists2: UserPermissionsLists = {
    hash: "h2",
    allow: ["Bash(npm:*)", "Read"],
    deny: ["Bash(curl:*)"],
    ask: ["Bash(rm:*)"],
    copiedAt: new Date().toISOString(),
  };
  await sessions.setUserPermissions(sid, lists2);
  deepEq(await sessions.getUserPermissions(sid), lists2, "second set replaces snapshot");

  // Independent session has its own lists.
  eq(await sessions.getUserPermissions("other-sid"), null, "other session has no permissions");

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
