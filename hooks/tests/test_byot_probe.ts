// hooks/tests/test_byot_probe.ts
// Run: npx tsx hooks/tests/test_byot_probe.ts
import { aggregateProbe } from "../../src/byot/capability-probe.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const allOk = await aggregateProbe([
    { model: "judge", api: "Converse", run: async () => {} },
    { model: "embed", api: "InvokeModel", run: async () => {} },
  ]);
  ok("all pass → ok:true, no failures", allOk.ok && allOk.failures.length === 0);

  const oneBad = await aggregateProbe([
    { model: "judge", api: "Converse", run: async () => {} },
    { model: "embed", api: "InvokeModel", run: async () => { const e: any = new Error("no"); e.name = "AccessDeniedException"; throw e; } },
  ]);
  ok("one fails → ok:false", !oneBad.ok);
  ok("failure names the model + error", oneBad.failures.length === 1 && oneBad.failures[0].model === "embed" && oneBad.failures[0].error === "AccessDeniedException");

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
