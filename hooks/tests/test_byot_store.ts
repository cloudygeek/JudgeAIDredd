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

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
