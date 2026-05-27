// hooks/tests/test_byot_store.ts
// Run: npx tsx hooks/tests/test_byot_store.ts
import { InMemoryByotStore } from "../../src/byot-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const store = new InMemoryByotStore();
  ok("get on empty returns null", (await store.get("u1")) === null);

  await store.put({
    ownerSub: "u1", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: "CT", last4: "abcd", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
  });
  const r = await store.get("u1");
  ok("get returns the stored record", r?.ciphertext === "CT" && r?.region === "eu-west-2");
  ok("scoped to ownerSub", (await store.get("u2")) === null);

  await store.markRuntimeFallback("u1", "AccessDeniedException", "t1");
  const r2 = await store.get("u1");
  ok("markRuntimeFallback sets status + reason", r2?.status === "runtime-fallback" && r2?.lastFallbackReason === "AccessDeniedException");
  ok("markRuntimeFallback preserves ciphertext", r2?.ciphertext === "CT");

  await store.delete("u1");
  ok("delete removes the row", (await store.get("u1")) === null);

  // DynamoByotStore against an in-memory fake DynamoDBDocumentClient.
  const { DynamoByotStore } = await import("../../src/dynamo-byot-store.js");
  const fakeTable = new Map<string, any>();
  const fakeClient = {
    async send(cmd: any): Promise<any> {
      const name = cmd.constructor.name;
      const key = (k: any) => `${k.pk}|${k.sk}`;
      if (name === "PutCommand") { fakeTable.set(key(cmd.input.Item), cmd.input.Item); return {}; }
      if (name === "GetCommand") { return { Item: fakeTable.get(key(cmd.input.Key)) }; }
      if (name === "DeleteCommand") { fakeTable.delete(key(cmd.input.Key)); return {}; }
      if (name === "UpdateCommand") {
        const item = fakeTable.get(key(cmd.input.Key));
        if (item) {
          item.status = cmd.input.ExpressionAttributeValues[":s"];
          item.lastFallbackAt = cmd.input.ExpressionAttributeValues[":a"];
          item.lastFallbackReason = cmd.input.ExpressionAttributeValues[":r"];
          item.updatedAt = cmd.input.ExpressionAttributeValues[":a"];
        }
        return {};
      }
      throw new Error("unexpected command " + name);
    },
  } as any;
  const dyn = new DynamoByotStore({ tableName: "jaid-byot", region: "eu-west-1", client: fakeClient });
  await dyn.put({
    ownerSub: "d1", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: "CT2", last4: "wxyz", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
  });
  const dr = await dyn.get("d1");
  ok("dynamo round-trips", dr?.ciphertext === "CT2" && dr?.last4 === "wxyz");
  await dyn.markRuntimeFallback("d1", "ThrottlingException", "t9");
  ok("dynamo markRuntimeFallback", (await dyn.get("d1"))?.status === "runtime-fallback");
  await dyn.delete("d1");
  ok("dynamo delete", (await dyn.get("d1")) === null);

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

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
