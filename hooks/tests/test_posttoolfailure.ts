/**
 * PostToolUseFailure — recordToolFailure store semantics.
 *
 * Verifies the outcome model: a failure paired by toolUseId decorates the
 * existing PreToolUse decision row (no new entry, decision unchanged); an
 * unpaired failure appends a standalone outcome-only row; the error text is
 * capped. No HTTP, no Ollama — drives InMemorySessionStore directly.
 *
 * Run: npx tsx hooks/tests/test_posttoolfailure.ts
 */

import { InMemorySessionStore } from "../../src/session-tracker.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

async function main() {
  // -----------------------------------------------------------------------
  section("Failure paired by toolUseId decorates the decision row");
  {
    const store = new InMemorySessionStore();
    const sid = "s-pair";
    await store.recordToolCall(sid, "Bash", { command: "node x.js" }, "allow", 0.9, "toolu_1", { stage: "judge-allow" });
    await store.recordToolFailure(sid, "Bash", { command: "node x.js" }, "toolu_1", "Error: boom");

    const summary = await store.getSessionSummary(sid);
    summary.toolCalls === 1 ? pass("still one tool-history row (decorated, not duplicated)") : fail(`toolCalls=${summary.toolCalls}`);

    const ctx = await store.getSessionContext(sid);
    const row = ctx.recentTools[0];
    row?.decision === "allow" ? pass("decision unchanged (allow)") : fail(`decision=${row?.decision}`);
    row?.stage === "judge-allow" ? pass("original stage preserved") : fail(`stage=${row?.stage}`);
    row?.outcome?.status === "error" ? pass("outcome.status === 'error'") : fail(`outcome=${JSON.stringify(row?.outcome)}`);
    row?.outcome?.error === "Error: boom" ? pass("outcome.error captured") : fail(`error=${row?.outcome?.error}`);
    row?.outcome?.at ? pass("outcome.at stamped") : fail("outcome.at missing");
  }

  // -----------------------------------------------------------------------
  section("Unpaired failure appends a standalone outcome row");
  {
    const store = new InMemorySessionStore();
    const sid = "s-unpaired";
    // No prior decision with this id.
    await store.recordToolFailure(sid, "Bash", { command: "curl evil" }, "toolu_missing", "net down");

    const ctx = await store.getSessionContext(sid);
    ctx.recentTools.length === 1 ? pass("one standalone row appended") : fail(`rows=${ctx.recentTools.length}`);
    const row = ctx.recentTools[0];
    row?.stage === "post-tool-failure" ? pass("stage === 'post-tool-failure'") : fail(`stage=${row?.stage}`);
    row?.decision === "allow" ? pass("standalone decision === 'allow' (the call DID run)") : fail(`decision=${row?.decision}`);
    row?.outcome?.error === "net down" ? pass("standalone carries the error") : fail(`error=${row?.outcome?.error}`);
    row?.tool === "Bash" ? pass("tool name preserved on standalone") : fail(`tool=${row?.tool}`);
  }

  // -----------------------------------------------------------------------
  section("Null toolUseId always appends standalone (can't pair)");
  {
    const store = new InMemorySessionStore();
    const sid = "s-null";
    await store.recordToolCall(sid, "Bash", { command: "node y.js" }, "allow", 0.9, null, {});
    await store.recordToolFailure(sid, "Bash", { command: "node y.js" }, null, "oops");
    const ctx = await store.getSessionContext(sid);
    ctx.recentTools.length === 2 ? pass("null id does not decorate — appends a second row") : fail(`rows=${ctx.recentTools.length}`);
    ctx.recentTools[1]?.outcome?.error === "oops" ? pass("standalone row holds the failure") : fail("missing outcome");
  }

  // -----------------------------------------------------------------------
  section("Error text capped at 2000 chars");
  {
    const store = new InMemorySessionStore();
    const sid = "s-cap";
    await store.recordToolCall(sid, "Bash", { command: "x" }, "allow", 0.5, "toolu_big", {});
    await store.recordToolFailure(sid, "Bash", { command: "x" }, "toolu_big", "E".repeat(5000));
    const ctx = await store.getSessionContext(sid);
    const len = ctx.recentTools[0]?.outcome?.error.length ?? 0;
    len === 2000 ? pass("error capped to 2000") : fail(`len=${len}`);
  }

  // -----------------------------------------------------------------------
  section("Most-recent matching row is decorated when ids repeat");
  {
    const store = new InMemorySessionStore();
    const sid = "s-dup";
    // Two calls share a toolUseId (pathological, but the search is last-wins).
    await store.recordToolCall(sid, "Bash", { command: "a" }, "allow", 0.9, "dup", { stage: "judge-allow" });
    await store.recordToolCall(sid, "Bash", { command: "b" }, "allow", 0.9, "dup", { stage: "drift-allow" });
    await store.recordToolFailure(sid, "Bash", { command: "b" }, "dup", "second failed");
    const ctx = await store.getSessionContext(sid);
    ctx.recentTools[1]?.outcome?.error === "second failed" ? pass("the latest matching row gets the outcome") : fail("wrong row decorated");
    ctx.recentTools[0]?.outcome === undefined ? pass("the earlier row is left untouched") : fail("earlier row wrongly decorated");
  }

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
