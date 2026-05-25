/**
 * Policy regression: VCS `rm` subcommands must not trip the destructive-rm
 * hard deny.
 *
 * Surfaced by the 30-day deny-log review (2026-05-23): `git rm -r <path>`
 * was hard-denied as "Destructive rm with force/recursive flags" because
 * the deny regex matched the substring "rm -r" inside "git rm -r". `git rm`
 * (and svn/hg/jj/bzr rm) are version-control removals — staged and
 * recoverable — not the destructive filesystem `rm`.
 *
 * Run: npx tsx hooks/tests/test_policy_vcs_rm.ts
 */

import { evaluateToolPolicy } from "../../src/tool-policy.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

function notDeny(label: string, command: string) {
  const r = evaluateToolPolicy("Bash", { command });
  r.decision !== "deny"
    ? pass(`${label} → ${r.decision} (not hard-deny)`)
    : fail(`${label} → DENY (${r.reason}) — should not hard-deny`);
}
function isDeny(label: string, command: string) {
  const r = evaluateToolPolicy("Bash", { command });
  r.decision === "deny"
    ? pass(`${label} → deny (${r.reason})`)
    : fail(`${label} → ${r.decision} — should be denied`);
}

function main() {
  section("VCS rm subcommands are NOT destructive-rm");
  notDeny("git rm -r dir/", "git rm -r p14/cross_vendor_harness/");
  notDeny("git rm -rf path", "git rm -rf lambdas/timestream-api");
  notDeny("git rm --recursive", "git rm --recursive some/dir");
  notDeny("svn rm file", "svn rm foo.txt");
  notDeny("hg rm -f file", "hg rm -f bar.txt");
  notDeny("git -C /repo rm -r x", "git -C /repo rm -r src/old");

  section("Real destructive rm is STILL denied");
  isDeny("rm -rf absolute path", "rm -rf /Users/adrian/project/build");
  isDeny("rm -fr (flag order)", "rm -fr /home/user/stuff");
  isDeny("rm --recursive --force", "rm --recursive --force /data/x");
  isDeny("chained git rm then rm -rf", "git rm -r staged/ && rm -rf /etc/important");

  section("Existing carve-outs still hold");
  notDeny("rm -f literal file", "rm -f build-artifact.zip");
  notDeny("rm -rf under /tmp", "rm -rf /tmp/scratch");

  section("Lookbehind doesn't over-match similar words");
  notDeny("confirm with -r-ish arg (not rm)", "confirm --recursive thing");

  // Surfaced 2026-05-25: a multi-line script (newline-separated commands)
  // was NOT split by splitChainedSafely, so `rm -rf /tmp/...` on its own
  // line was evaluated inside the whole blob — the anchored /tmp carve-out
  // (^rm) couldn't fire, but the unanchored deny pattern matched. Newlines
  // are command separators in bash; the splitter must treat them as such.
  section("Newline-separated commands are split (per-line carve-outs apply)");
  notDeny(
    "multiline: rm -rf /tmp/a /tmp/b among other lines",
    'echo "stage"\nrm -rf /tmp/dredd-rezip-hook /tmp/dredd-rezip-dash\nmkdir -p /tmp/a',
  );
  isDeny(
    "multiline: real destructive rm on its own line still denies",
    'echo hi\nrm -rf /Users/adrian/project\necho done',
  );
  notDeny(
    "line-continuation is joined, not shredded into a bare rm",
    "echo start\nrm -rf /tmp/scratch \\\n  /tmp/other",
  );

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
