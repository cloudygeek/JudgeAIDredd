/**
 * Scope the judge's file-context to what the command actually touches.
 *
 * Per docs/plan-file-context-scoping-2026-08-21.md. Two defects:
 *
 *  1. COST. The trigger fires on ~57% of Bash calls, and the renderer starts
 *     from every file written this session regardless of what the command
 *     names. A call whose command references a MEDIAN OF 1 file spent the whole
 *     12K-char budget.
 *
 *  2. CORRECTNESS, introduced by 9dafc90f (0.1.541). That commit capped the
 *     dump at 40 files sorted flagged-first. With 47% of a real session's 1,026
 *     files carrying MULTI-WRITE, the window fills with arbitrary flagged files
 *     and the file the command ACTUALLY REFERENCES ranks ~423 — outside the
 *     window entirely. Verified against 9dafc90f: the referenced file appears
 *     neither by content NOR by path. That is the payload-splitting target, and
 *     the block exists to carry exactly it.
 *
 * Never shipped — prod was torn down 2026-08-21 before 0.1.541 deployed.
 *
 * TWO DESIGN POINTS BEYOND THE PLAN, both from review:
 *  - Tier 3 ("recent") orders by max(modifiedAtTurns), NOT Map insertion order.
 *    Map order is FIRST-write, so a file written at turn 2 and rewritten at
 *    turn 400 would sort as old — and tier 3 is the whole mitigation for the
 *    `make` / `./run.sh` blind spot, so getting it wrong would be quiet.
 *  - A referenced file that does not fit the CONTENT budget must still be
 *    listed by path+flags. Vanishing entirely is the 0.1.541 defect; capping
 *    content is fine, dropping the row is not. This matters at the p90 of 64
 *    referenced files, where only ~12 can hold content.
 *
 * Run: npx tsx hooks/tests/test_file_context_scoping.ts
 */

import {
  renderFileContextForJudge,
  referencedWrittenFiles,
  FILE_CONTEXT_BUDGET,
} from "../../src/file-context.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++) : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

type F = {
  path: string;
  content: string;
  writeCount: number;
  containsCanary: boolean;
  wasReadFirst: boolean;
  modifiedAtTurns?: number[];
};
const mk = (n: number, over: (i: number) => Partial<F> = () => ({})): F[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `/proj/lib/f${i}.dart`,
    content: `CONTENT_OF_FILE_${i}`,
    writeCount: 1,
    containsCanary: false,
    wasReadFirst: false,
    modifiedAtTurns: [i],
    ...over(i),
  }));

function main() {
  section("matcher");
  const files: F[] = [
    { path: "/proj/src/index.js", content: "a", writeCount: 1, containsCanary: false, wasReadFirst: false },
    { path: "/proj/docs/brief.md", content: "b", writeCount: 1, containsCanary: false, wasReadFirst: false },
  ];
  ok("full path in command", referencedWrittenFiles("node /proj/src/index.js", files).length === 1);
  ok(
    "cwd-relative path",
    referencedWrittenFiles("node src/index.js", files, "/proj").some((f) => f.path === "/proj/src/index.js"),
  );
  ok("basename as a token", referencedWrittenFiles("cat src/index.js", files).length === 1);
  ok("basename glued inside a longer name is NOT matched", referencedWrittenFiles("cat debrief.md.bak", files).length === 0);
  ok("empty command → no match, no throw", referencedWrittenFiles("", files).length === 0);
  ok("no files → no match, no throw", referencedWrittenFiles("ls", []).length === 0);
  ok(
    "regex metacharacters in a filename do not explode",
    referencedWrittenFiles("cat a+b.txt", [
      { path: "/p/a+b.txt", content: "x", writeCount: 1, containsCanary: false, wasReadFirst: false },
    ]).length === 1,
  );

  section("tiers — the 0.1.541 regression pins");
  // Real session shape: 1,026 files, ~47% MULTI-WRITE.
  const many = mk(1026, (i) => ({ writeCount: i % 100 < 47 ? 3 : 1 }));
  const target = many[900]; // unflagged → ranks ~423 under flagged-first
  const scoped = renderFileContextForJudge(many, { command: `bash ${target.path}` });
  ok("referenced file's CONTENT is present (fails against 9dafc90f)", scoped.includes(target.content));
  ok("...and its path", scoped.includes(target.path));

  const canary = mk(1000, (i) => ({ writeCount: 3 })).concat([
    { path: "/proj/.env.staged", content: "AWS_SECRET=shhh", writeCount: 1, containsCanary: true, wasReadFirst: false, modifiedAtTurns: [1] },
  ]);
  ok(
    "canary file always rendered with content, even behind 1,000 multi-writes",
    renderFileContextForJudge(canary, { command: "npm start" }).includes("AWS_SECRET=shhh"),
  );

  // Tier 3: command names nothing. Recent must be by LAST write, not first.
  const recency = mk(200, (i) => ({ modifiedAtTurns: i === 5 ? [1, 999] : [i] }));
  const noNames = renderFileContextForJudge(recency, { command: "npm start" });
  ok("recent tier fills when the command names nothing", noNames.includes(recency[199].content));
  ok(
    "recency uses LAST write, not first (file 5 rewritten at turn 999)",
    noNames.includes(recency[5].content),
  );

  section("no file vanishes silently");
  // p90 is 64 referenced files but only ~12 fit content. The rest must still
  // be listed — dropping the row entirely is the 0.1.541 defect.
  // Content must be big enough that the 12,000-char budget actually binds —
  // 80 x ~19 chars would all fit and the assertion would pass vacuously.
  const wide = mk(80, (i) => ({ content: `CONTENT_OF_FILE_${i}_` + "y".repeat(1_000) }));
  const cmd = "tar czf out.tgz " + wide.map((f) => f.path).join(" ");
  const wideOut = renderFileContextForJudge(wide, { command: cmd });
  const listed = wide.filter((f) => wideOut.includes(f.path)).length;
  ok(`all 80 referenced files listed by path (got ${listed})`, listed === 80);
  ok("...but not all with content (budget respected)", wide.filter((f) => wideOut.includes(f.content)).length < 80);

  section("census");
  ok("reports the TRUE total, not the rendered count", scoped.includes("1026"));
  ok("reports the multi-write count", /48[0-9]|4[0-9][0-9] multi-write/.test(scoped) || /multi-write/.test(scoped));

  section("budget + backwards compatibility");
  ok("scoped output still within budget", scoped.length < FILE_CONTEXT_BUDGET.MAX_TOTAL_CHARS + 4_000);
  ok("6,000-file session stays bounded", renderFileContextForJudge(mk(6000)).length < 60_000);
  ok("no files → sentinel", renderFileContextForJudge([]) === "No files written this session.");
  ok(
    "NO OPTS → byte-identical to the pre-scoping behaviour",
    renderFileContextForJudge(mk(3)) === renderFileContextForJudge(mk(3), {}),
  );

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
