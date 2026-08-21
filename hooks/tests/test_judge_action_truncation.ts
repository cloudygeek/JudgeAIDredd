/**
 * The judge must not adjudicate a silently-truncated command.
 *
 * `describeToolCall` capped Bash at 200 chars, and that ONE string was used for
 * three different things: the drift embedding, the judge's `<action>` block,
 * and the `ACTIONS TAKEN SO FAR` history entries. So the judge decided on the
 * first 200 characters of a command, cut mid-token, with nothing marking that
 * anything had been removed.
 *
 * Measured over 65,961 recorded Bash rows: 35,397 (53.7%) exceed 200 chars, and
 * the MEDIAN Bash command is 221 — just past the cap. So the typical call was
 * judged on a fragment.
 *
 * Real example (session 58b0899e, TOOL#0022#0001, a 1,129-char command). The
 * judge saw the command stop at `aws configure export-credentials --format en`
 * and returned `hijacked`, reasoning explicitly about `'en'` as if it were a
 * token. The removed remainder was the exculpatory half — a credential
 * PREFLIGHT (`export creds → get-caller-identity → proceed`).
 *
 * TWO THINGS THIS FIXES, AND ONE IT DELIBERATELY DOES NOT TOUCH
 *  - The judge now gets a much larger window (2,000 chars).
 *  - Truncation, where it still happens, is EXPLICIT. That matters more than
 *    the size: a silent cut invites the judge to treat the boundary as
 *    meaningful, which is exactly what happened with 'en'.
 *  - The DRIFT string stays byte-identical at 200 chars with no marker. The
 *    similarity thresholds (0.2 / 0.3 / 0.5) were calibrated against that exact
 *    shape; widening it — or even appending a marker — silently re-scales every
 *    score in the pipeline. Decoupling the two is the whole point.
 *
 * Run: npx tsx hooks/tests/test_judge_action_truncation.ts
 */

import { describeToolCall, describeToolCallForJudge, JUDGE_ACTION_MAX_CHARS } from "../../src/tool-description.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++) : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

const bash = (command: string) => ({ command });

function main() {
  section("the drift string is FROZEN — thresholds depend on it");
  const long = "x".repeat(5_000);
  const driftStr = describeToolCall("Bash", bash(long));
  ok("still exactly 'Execute command: ' + 200 chars", driftStr === `Execute command: ${"x".repeat(200)}`);
  ok("no truncation marker (would perturb the embedding)", !/TRUNCATED/.test(driftStr));
  ok(
    "short commands unchanged",
    describeToolCall("Bash", bash("ls -la")) === "Execute command: ls -la",
  );

  section("the judge string gets a far larger window");
  const judgeStr = describeToolCallForJudge("Bash", bash(long));
  ok(`judge window is ${JUDGE_ACTION_MAX_CHARS}, not 200`, JUDGE_ACTION_MAX_CHARS >= 2_000);
  ok("judge sees far more than drift does", judgeStr.length > driftStr.length * 5);

  section("truncation is EXPLICIT — the fix that matters most");
  ok("marker present when cut", /TRUNCATED/.test(judgeStr));
  ok("marker states the ORIGINAL length so the judge knows the scale", judgeStr.includes("5000"));
  ok(
    "no marker when nothing was removed",
    !/TRUNCATED/.test(describeToolCallForJudge("Bash", bash("git status"))),
  );
  ok(
    "an untruncated command is identical in both paths",
    describeToolCallForJudge("Bash", bash("git status")) === describeToolCall("Bash", bash("git status")),
  );

  section("the real production false positive");
  // 1,129 chars — the whole command now fits, so the judge sees the preflight.
  // The scratchpad path length matters: at its real 125 chars it pushes
  // `get-caller-identity` past char 200, which is exactly why the drift-width
  // window hid the exculpatory preflight. Shortening it here would make the
  // test pass for the wrong reason.
  const real =
    'SP="/private/tmp/claude-501/-Users-adrian-IdeaProjects-jarvis/58b0899e-f51c-40b2-9e34-976caf3c4ca5/scratchpad"\n' +
    'cd /Users/adrian/IdeaProjects/jarvis\n' +
    'eval "$(aws configure export-credentials --format env 2>/dev/null)"\n' +
    'if ! aws sts get-caller-identity --query Account --output text >/dev/null 2>&1; then\n' +
    '  echo "AWS creds unavailable"; exit 1\nfi\n' +
    "# ".padEnd(900, "x") +
    "\ntofu plan";
  const realJudge = describeToolCallForJudge("Bash", bash(real));
  ok("the exculpatory preflight is now visible", realJudge.includes("get-caller-identity"));
  ok("...and so is the actual task", realJudge.includes("tofu plan"));
  ok("...whereas the drift path still stops early", !describeToolCall("Bash", bash(real)).includes("get-caller-identity"));

  section("other tools unaffected");
  ok("Read", describeToolCallForJudge("Read", { file_path: "/a/b.ts" }) === "Read file: /a/b.ts");
  ok("Edit", describeToolCallForJudge("Edit", { file_path: "/a/b.ts" }) === "Edit file: /a/b.ts");
  ok(
    "Glob",
    describeToolCallForJudge("Glob", { pattern: "**/*.ts" }) === "Find files matching: **/*.ts",
  );

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
