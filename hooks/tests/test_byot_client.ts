// hooks/tests/test_byot_client.ts
// Run: npx tsx hooks/tests/test_byot_client.ts
import { __clientForTest, isByotFallbackError } from "../../src/bedrock-client.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const d1 = __clientForTest("eu-west-2", { kind: "default" });
  const d2 = __clientForTest("eu-west-2", { kind: "default" });
  ok("same region+default → same client instance", d1 === d2);

  const b1 = __clientForTest("eu-west-2", { kind: "bearer", token: "tok-A", region: "eu-west-2" });
  ok("bearer client differs from default", b1 !== d1);

  const b2 = __clientForTest("eu-west-2", { kind: "bearer", token: "tok-A", region: "eu-west-2" });
  ok("same token → same client (cached)", b1 === b2);

  const b3 = __clientForTest("eu-west-2", { kind: "bearer", token: "tok-B", region: "eu-west-2" });
  ok("different token → different client", b3 !== b1);

  // isByotFallbackError classifier.
  ok("classified error name → fallback eligible", isByotFallbackError({ name: "AccessDeniedException" }) === true);
  ok("unclassified error name → not eligible", isByotFallbackError({ name: "ValidationException" }) === false);
  ok("plain Error → not eligible", isByotFallbackError(new Error("boom")) === false);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
