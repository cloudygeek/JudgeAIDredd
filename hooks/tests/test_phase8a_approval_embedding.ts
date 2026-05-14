/**
 * Phase 8a — approval embedding capture + listForScope.
 *
 * Pure store-layer test. Exercises:
 *   - ApprovalRecord round-trips inputEmbedding
 *   - Legacy callers that omit inputEmbedding get an [] stored
 *   - listForScope returns only live (non-revoked, non-expired)
 *     approvals for the requested (ownerSub, projectRoot)
 *   - Cross-project / cross-user isolation
 *
 * Run: npx tsx hooks/tests/test_phase8a_approval_embedding.ts
 */

import {
  InMemoryApprovalStore,
  type RecordApprovalInput,
} from "../../src/approval-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

function baseInput(over: Partial<RecordApprovalInput> = {}): RecordApprovalInput {
  return {
    scope: { ownerSub: "user-a", projectRoot: "/proj/foo" },
    ownerEmail: "u@example.com",
    fingerprintHash: "fp-" + Math.random().toString(36).slice(2, 10),
    fingerprintJson: '{"k":"v"}',
    summary: "test approval",
    tool: "Bash",
    intentSnapshot: "do something",
    goalEmbedding: [0.1, 0.2, 0.3],
    inputEmbedding: [0.4, 0.5, 0.6],
    ...over,
  };
}

async function main() {
  // -------------------------------------------------------------------------
  section("Round-trip inputEmbedding");

  const store = new InMemoryApprovalStore();
  const rec = await store.recordApproval(baseInput({
    fingerprintHash: "fp-rt",
    inputEmbedding: [0.11, 0.22, 0.33, 0.44],
  }));
  JSON.stringify(rec.inputEmbedding) === JSON.stringify([0.11, 0.22, 0.33, 0.44])
    ? pass("recordApproval returns the embedding it was given")
    : fail(`mismatch: got ${JSON.stringify(rec.inputEmbedding)}`);

  const found = await store.lookup({ ownerSub: "user-a", projectRoot: "/proj/foo" }, "fp-rt");
  found && JSON.stringify(found.inputEmbedding) === JSON.stringify([0.11, 0.22, 0.33, 0.44])
    ? pass("lookup returns same embedding")
    : fail(`lookup mismatch: ${JSON.stringify(found?.inputEmbedding)}`);

  // -------------------------------------------------------------------------
  section("Legacy callers — missing inputEmbedding stored as []");

  // Force-cast to drop the field — simulates a caller that hasn't been
  // updated yet. The store must tolerate it.
  const partial = { ...baseInput({ fingerprintHash: "fp-legacy" }) } as RecordApprovalInput;
  // @ts-expect-error — testing tolerance for callers that haven't filled the new field
  delete partial.inputEmbedding;
  const recLegacy = await store.recordApproval(partial);
  Array.isArray(recLegacy.inputEmbedding) && recLegacy.inputEmbedding.length === 0
    ? pass("missing inputEmbedding stored as []")
    : fail(`legacy: ${JSON.stringify(recLegacy.inputEmbedding)}`);

  // -------------------------------------------------------------------------
  section("listForScope — basic semantics");

  const scope = { ownerSub: "user-a", projectRoot: "/proj/foo" };
  const list = await store.listForScope(scope);
  // Should contain rt + legacy (both for user-a / /proj/foo).
  list.length === 2 ? pass("listForScope returns 2 live records") : fail(`got ${list.length}: ${list.map(r => r.fingerprintHash).join(",")}`);

  // -------------------------------------------------------------------------
  section("listForScope — isolation");

  await store.recordApproval(baseInput({
    fingerprintHash: "fp-other-user",
    scope: { ownerSub: "user-b", projectRoot: "/proj/foo" },
  }));
  await store.recordApproval(baseInput({
    fingerprintHash: "fp-other-proj",
    scope: { ownerSub: "user-a", projectRoot: "/proj/bar" },
  }));

  const stillFoo = await store.listForScope(scope);
  stillFoo.length === 2 && stillFoo.every(r => r.ownerSub === "user-a" && r.projectRoot === "/proj/foo")
    ? pass("scope isolation: only (user-a, /proj/foo) returned")
    : fail(`got ${stillFoo.length}: ${stillFoo.map(r => `${r.ownerSub}/${r.projectRoot}`).join(", ")}`);

  // -------------------------------------------------------------------------
  section("listForScope — excludes revoked");

  await store.revoke(scope, "fp-rt", "admin@example.com");
  const afterRevoke = await store.listForScope(scope);
  afterRevoke.length === 1 && afterRevoke[0].fingerprintHash === "fp-legacy"
    ? pass("revoked record dropped from listForScope")
    : fail(`got ${afterRevoke.length}: ${afterRevoke.map(r => r.fingerprintHash).join(",")}`);

  // -------------------------------------------------------------------------
  section("listForScope — excludes expired");

  // Plant a manually-aged record by bypassing the store's API.
  const expiredRec = await store.recordApproval(baseInput({
    fingerprintHash: "fp-expired",
    scope,
  }));
  expiredRec.expiresAt = new Date(Date.now() - 1000).toISOString();
  const afterAge = await store.listForScope(scope);
  afterAge.every(r => r.fingerprintHash !== "fp-expired")
    ? pass("expired record dropped from listForScope")
    : fail(`expired record leaked: ${afterAge.map(r => r.fingerprintHash).join(",")}`);

  // -------------------------------------------------------------------------
  section("listForScope — limit");

  // Add a few more; ask for limit=2.
  for (let i = 0; i < 5; i++) {
    await store.recordApproval(baseInput({
      fingerprintHash: `fp-bulk-${i}`,
      scope,
    }));
  }
  const limited = await store.listForScope(scope, 2);
  limited.length === 2 ? pass("limit cap respected") : fail(`got ${limited.length}`);

  // -------------------------------------------------------------------------
  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
