/**
 * Sandbox-relative `rm` carve-out (2026-05-31).
 *
 * The destructive-rm deny is blunt. With the session's live cwd forwarded on
 * /evaluate (and the first-prompt projectRoot as fallback), we can resolve rm
 * targets and grade them:
 *   - rm -f (non-recursive): safe relative files / in-project / /tmp → allow
 *   - rm -rf (recursive): /tmp → allow; in-project → REVIEW (judge/user
 *     adjudicates, no longer a hard block); anything else → deny
 *   - out-of-sandbox, $var, glob, ~, .., or the project root itself → deny
 *
 * Critical invariant: with NO cwd/projectRoot threaded, behaviour is exactly
 * as before (only /tmp + literal-file carve-outs apply) — see the
 * "no context" section.
 *
 * Run: npx tsx hooks/tests/test_policy_rm_sandbox.ts
 */

import { evaluateToolPolicy } from "../../src/tool-policy.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

function expect(
  label: string,
  command: string,
  want: "allow" | "review" | "deny",
  ctx?: { projectRoot?: string | null; cwd?: string | null },
) {
  const r = evaluateToolPolicy("Bash", { command }, ctx?.projectRoot ?? null, ctx?.cwd ?? null);
  r.decision === want
    ? pass(`${label} → ${r.decision}`)
    : fail(`${label} → ${r.decision} (wanted ${want}) [${r.reason}]`);
}

const PROJ = "/Users/adrian/IdeaProjects/foo";

function main() {
  section("rm -f (non-recursive): multiple literal files → allow");
  expect("LaTeX cleanup, no cwd", "rm -f p14.aux p14.bbl p14.blg p14.log p14.out p14.pdf", "allow");
  expect("multi rel files, no cwd", "rm -f a.txt b.txt c.txt", "allow");
  expect("single literal still allowed", "rm -f build-artifact.zip", "allow");
  expect("rel files under project cwd", "rm -f main.o util.o", "allow", { projectRoot: PROJ, cwd: PROJ });

  section("rm -f with unsafe targets → still deny");
  expect("glob target", "rm -f *.log", "deny");
  expect("variable target", 'rm -f "$F"', "deny");
  expect("path traversal", "rm -f ../outside.txt", "deny");
  expect("absolute system file", "rm -f /etc/hosts", "deny");
  expect("home target", "rm -f ~/secret", "deny");

  section("rm -rf (recursive) in-project → REVIEW (cwd resolves the path)");
  expect("rm -rf .venv in project", "rm -rf .venv", "review", { projectRoot: PROJ, cwd: PROJ });
  expect("rm -rf __pycache__ in project", "rm -rf __pycache__", "review", { projectRoot: PROJ, cwd: PROJ });
  expect("rm -rf build subdir", "rm -rf build", "review", { projectRoot: PROJ, cwd: PROJ });
  expect("rm -rf absolute path under project", `rm -rf ${PROJ}/dist`, "review", { projectRoot: PROJ, cwd: PROJ });

  section("rm -rf out-of-sandbox / dangerous → deny (even with project ctx)");
  expect("absolute outside project", "rm -rf /etc/important", "deny", { projectRoot: PROJ, cwd: PROJ });
  expect("the project root itself", `rm -rf ${PROJ}`, "deny", { projectRoot: PROJ, cwd: PROJ });
  expect("home dir", "rm -rf ~/", "deny", { projectRoot: PROJ, cwd: PROJ });
  expect("variable target", 'rm -rf "$B"', "deny", { projectRoot: PROJ, cwd: PROJ });
  expect("mixed in+out denies", `rm -rf .venv /etc/x`, "deny", { projectRoot: PROJ, cwd: PROJ });

  section("/tmp recursive stays allow (scratch)");
  expect("rm -rf /tmp/scratch", "rm -rf /tmp/scratch", "allow");
  expect("rm -f /tmp files", "rm -f /tmp/a /tmp/b", "allow");

  section("chained cd is tracked so targets resolve against the cd'd dir");
  // cd /tmp then rm: rm part allowed (tmp), but cd-escape combo → review overall
  expect("cd /tmp && rm -rf X → review (escape)", "cd /tmp && rm -rf cflinkcpp-src", "review");
  // cd /etc then rm -f relative: resolves to /etc/foo → outside → deny
  expect("cd /etc && rm -f foo.conf → deny", "cd /etc && rm -f foo.conf", "deny");

  section("NO context: behaviour unchanged (recursive rel can't be confirmed)");
  expect("rm -rf absolute path (no ctx)", "rm -rf /Users/adrian/project/build", "deny");
  expect("rm -rf relative dir (no ctx) stays deny", "rm -rf .venv", "deny");
  expect("rm -rf /tmp (no ctx) still allow", "rm -rf /tmp/x", "allow");

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
