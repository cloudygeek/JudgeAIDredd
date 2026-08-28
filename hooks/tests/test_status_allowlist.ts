// hooks/tests/test_status_allowlist.ts
// Run: npx tsx hooks/tests/test_status_allowlist.ts
//
// DREDD_STATUS_ALLOWED_EMAILS semantics: unset/empty → every authenticated
// account may view the status surfaces (pre-allowlist behaviour); set →
// only listed emails (case-insensitive, whitespace-tolerant) plus the
// hard-coded ADMIN_EMAILS. Pure — no live Clerk, no env mutation: the
// tests drive parseStatusAllowlist + isStatusViewer's explicit allowlist
// parameter, the same values the production default parameter is built
// from at module load.
import { parseStatusAllowlist, isStatusViewer } from "../../src/clerk-auth.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

// The two hard-coded admins from ADMIN_EMAILS in src/clerk-auth.ts.
const ADMIN_1 = "adrian.asher@checkout.com";
const ADMIN_2 = "adrianasher30@gmail.com";

function main() {
  // --- parseStatusAllowlist: unset / empty / blank → null (no restriction) ---
  ok("unset (undefined) parses to null", parseStatusAllowlist(undefined) === null);
  ok("unset (null) parses to null", parseStatusAllowlist(null) === null);
  ok("empty string parses to null", parseStatusAllowlist("") === null);
  ok("whitespace-only parses to null", parseStatusAllowlist("   ") === null);
  ok("separators-only parses to null", parseStatusAllowlist(" , ,, ") === null);

  // --- parseStatusAllowlist: normalisation ---
  const list = parseStatusAllowlist("  Alice@Example.COM , bob@corp.io ,,");
  ok("entries are trimmed + lowercased", !!list && list.has("alice@example.com") && list.has("bob@corp.io"));
  ok("blank entries dropped (size 2)", list?.size === 2);

  // --- unset → everyone allowed ---
  ok("no allowlist: arbitrary email allowed", isStatusViewer("random@user.dev", null) === true);
  ok("no allowlist: empty email allowed", isStatusViewer("", null) === true);
  ok("no allowlist: null email allowed", isStatusViewer(null, null) === true);
  ok("empty-string env behaves as unset", isStatusViewer("random@user.dev", parseStatusAllowlist("")) === true);

  // --- set → listed allowed, unlisted refused ---
  const set = parseStatusAllowlist("alice@example.com, bob@corp.io");
  ok("listed email allowed", isStatusViewer("alice@example.com", set) === true);
  ok("listed email allowed case-insensitively", isStatusViewer("ALICE@Example.Com", set) === true);
  ok("caller-side whitespace tolerated", isStatusViewer("  bob@corp.io  ", set) === true);
  ok("env-side case difference tolerated", isStatusViewer("bob@corp.io", parseStatusAllowlist("BOB@CORP.IO")) === true);
  ok("unlisted email refused", isStatusViewer("mallory@evil.net", set) === false);
  ok("empty email refused when list set", isStatusViewer("", set) === false);
  ok("null email refused when list set", isStatusViewer(null, set) === false);
  ok("undefined email refused when list set", isStatusViewer(undefined, set) === false);

  // --- admins always allowed, even off-list ---
  ok("admin 1 allowed despite not being listed", isStatusViewer(ADMIN_1, set) === true);
  ok("admin 2 allowed despite not being listed", isStatusViewer(ADMIN_2, set) === true);
  ok("admin allowed case-insensitively", isStatusViewer("AdrianAsher30@Gmail.com", set) === true);
  ok("admin allowed on a single-entry list excluding them", isStatusViewer(ADMIN_1, parseStatusAllowlist("someone@else.io")) === true);

  // --- default parameter mirrors the process env (works whether or not
  //     the suite-runner's shell happens to set the var) ---
  const envList = parseStatusAllowlist(process.env.DREDD_STATUS_ALLOWED_EMAILS);
  ok("default allowlist parameter mirrors process env",
     isStatusViewer("random@user.dev") === isStatusViewer("random@user.dev", envList));

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) process.exit(1);
}

main();
