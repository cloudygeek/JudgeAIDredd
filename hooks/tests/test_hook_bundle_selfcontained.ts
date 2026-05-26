// hooks/tests/test_hook_bundle_selfcontained.ts
// Run: npx tsx hooks/tests/test_hook_bundle_selfcontained.ts
//
// Regression test for the production bug where the integration bundle (and
// /api/hook-script) shipped a dredd-hook.sh that *sources* its sibling
// dredd-managed-allow.sh — a file neither delivery path included. Clients
// saw: "dredd_sweep_stale_sidecars: command not found" (hook line 514) and
// "dredd_reconcile_managed_allow: command not found" (line 685).
//
// The served hook must be SELF-CONTAINED: the managed-allow lib inlined,
// DREDD_URL baked, valid bash, no leftover source-of-lib line.
import { buildBakedHook } from "../../src/hook-bake.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

function main() {
  const url = "https://judge.example.test";
  const baked = buildBakedHook(url);

  const expectedUrl = 'DREDD_URL="${DREDD_URL:-' + url + '}"';
  ok("DREDD_URL baked to caller host", baked.includes(expectedUrl));

  // The three lib functions whose call sites previously errored / were
  // unguarded must be present as DEFINITIONS in the served file.
  ok("inlines dredd_sweep_stale_sidecars definition", baked.includes("dredd_sweep_stale_sidecars() {"));
  ok("inlines dredd_reconcile_managed_allow definition", baked.includes("dredd_reconcile_managed_allow() {"));
  ok("inlines dredd_cleanup_session definition", baked.includes("dredd_cleanup_session() {"));

  // The dev-only sourcing block must be gone in the baked output.
  ok("no dev-only source guard variable remains", !baked.includes("_dredd_lib="));
  ok("no leftover source of the sibling lib",
     !/(^|\n)\s*\.\s+"\$\(dirname[^\n]*dredd-managed-allow\.sh"/.test(baked));
  ok("carries the inlined-from marker", baked.includes("inlined from dredd-managed-allow.sh"));

  // Strongest check: the assembled script is syntactically valid bash.
  const dir = mkdtempSync(join(tmpdir(), "dredd-bake-"));
  const f = join(dir, "dredd-hook.sh");
  writeFileSync(f, baked, "utf8");
  let synOk = true;
  let synErr = "";
  try { execFileSync("bash", ["-n", f]); } catch (e) { synOk = false; synErr = String((e as Error).message); }
  ok("baked hook passes `bash -n` syntax check" + (synOk ? "" : ` (${synErr})`), synOk);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
