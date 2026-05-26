// hooks/tests/test_byot_crypto.ts
// Run: npx tsx hooks/tests/test_byot_crypto.ts
import { FakeByotCrypto } from "../../src/byot/byot-crypto.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const crypto = new FakeByotCrypto();
  const ct = await crypto.encrypt("super-secret-token", { ownerSub: "user_123" });
  ok("ciphertext is not the plaintext", ct !== "super-secret-token");
  const pt = await crypto.decrypt(ct, { ownerSub: "user_123" });
  ok("round-trips back to plaintext", pt === "super-secret-token");

  let threw = false;
  try { await crypto.decrypt(ct, { ownerSub: "someone_else" }); }
  catch { threw = true; }
  ok("decrypt with wrong ownerSub context throws", threw);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
