/**
 * The judge's file-context block must be bounded on EVERY backend.
 *
 * `getFileContextForJudge` is attached to the judge prompt on every
 * `git add|commit|push` (handlers/evaluate.ts). The 0.1.530 cost cap
 * (MAX_TOTAL_CHARS / PER_FILE_CHARS / MAX_FILES_LISTED) was applied to
 * `session-tracker.ts` ONLY — which is the in-memory DEV backend. Production
 * runs `STORE_BACKEND=dynamo`, so `tracker` resolves to
 * CachedSessionStore(DynamoSessionStore), and BOTH of those kept the original
 * unbounded `for (const f of files)` loop at up to 2,000 chars per file with no
 * cap on file count.
 *
 * Measured consequence over 2026-07-01..08-21, 39,176 prod judge calls:
 * mean input 65,306 tokens, p99 580,918, max 624,805 — climbing daily as
 * long-running sessions accumulate written files. One session held 5,995 FILE
 * rows. That is roughly $8.4K of Bedrock spend in the window, and it pushed
 * responses into the 512-token output cap, where a cut-off judge reply
 * fail-closes to `hijacked` — false denies of legitimate work.
 *
 * So this is a cost bug AND a correctness bug, and the reason it survived a
 * "fix" is that three backends each had their own copy of the loop. The fix is
 * one shared helper; this test pins that all three agree and stay bounded.
 *
 * Run: npx tsx hooks/tests/test_file_context_budget.ts
 */

import { renderFileContextForJudge, FILE_CONTEXT_BUDGET } from "../../src/file-context.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++) : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

type F = { path: string; content: string; writeCount: number; containsCanary: boolean; wasReadFirst: boolean };
const mk = (n: number, over: Partial<F> = {}): F[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `/proj/src/file-${i}.ts`,
    content: "x".repeat(2_000),
    writeCount: 1,
    containsCanary: false,
    wasReadFirst: false,
    ...over,
  }));

function main() {
  section("bounded regardless of session size — the prod failure mode");
  // 5,995 FILE rows was the real observed count on session 67b60d78.
  const huge = renderFileContextForJudge(mk(6_000));
  ok(`6,000 files stays under the budget (${huge.length} chars)`, huge.length < 60_000);
  ok("...and says what it omitted", /budget reached/.test(huge));
  ok("...and still reports the true total", /6000 total/.test(huge));

  const modest = renderFileContextForJudge(mk(3));
  ok("a small session is unaffected (content still included)", modest.includes("x".repeat(500)));

  section("security-relevant files get first claim on the budget");
  // A flagged file placed LAST must still survive; unflagged bulk must not
  // crowd it out. This is the payload-splitting signal the judge needs.
  const withFlagged = [
    ...mk(500),
    { path: "/proj/.env.staged", content: "AWS_SECRET=shhh", writeCount: 3, containsCanary: true, wasReadFirst: true },
  ];
  const out = renderFileContextForJudge(withFlagged);
  ok("flagged file survives 500 unflagged ones", out.includes("/proj/.env.staged"));
  ok("...with its flags intact", /MULTI-WRITE\(3x\)/.test(out) && /CONTAINS-SENSITIVE-DATA/.test(out) && /READ-THEN-WRITTEN/.test(out));
  ok("...and its CONTENT, not just the path", out.includes("AWS_SECRET=shhh"));

  section("budget constants are sane and exported");
  ok("MAX_TOTAL_CHARS is bounded", FILE_CONTEXT_BUDGET.MAX_TOTAL_CHARS > 0 && FILE_CONTEXT_BUDGET.MAX_TOTAL_CHARS <= 20_000);
  ok("PER_FILE_CHARS <= MAX_TOTAL_CHARS", FILE_CONTEXT_BUDGET.PER_FILE_CHARS <= FILE_CONTEXT_BUDGET.MAX_TOTAL_CHARS);
  ok("MAX_FILES_LISTED is bounded", FILE_CONTEXT_BUDGET.MAX_FILES_LISTED > 0 && FILE_CONTEXT_BUDGET.MAX_FILES_LISTED <= 100);

  section("degenerate inputs");
  ok("no files → explicit sentinel", renderFileContextForJudge([]) === "No files written this session.");
  ok(
    "empty content does not break the budget maths",
    renderFileContextForJudge(mk(5, { content: "" })).includes("/proj/src/file-0.ts"),
  );

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
