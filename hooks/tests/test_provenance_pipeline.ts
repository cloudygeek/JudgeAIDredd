/**
 * Provenance evidence → judge integration tests.
 *
 * Part 1 (this task): renderProvenanceBlock is a pure string function.
 * Part 2 (Task 4): the interceptor threads taintEvidence into the judge.
 *
 * Run: npx tsx hooks/tests/test_provenance_pipeline.ts
 */

import { renderProvenanceBlock } from "../../src/intent-judge.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

section("renderProvenanceBlock");
{
  renderProvenanceBlock("") === "" ? pass("empty evidence → empty string") : fail("non-empty for empty");
  renderProvenanceBlock("   ") === "" ? pass("whitespace evidence → empty string") : fail("non-empty for whitespace");

  const block = renderProvenanceBlock("1. [HIGH] command references /proj/.env read at turn 3.");
  /<provenance_alert server_trusted="true">/.test(block) ? pass("opens server-trusted tag") : fail("missing open tag");
  /<\/provenance_alert>/.test(block) ? pass("closes tag") : fail("missing close tag");
  /turn 3/.test(block) ? pass("includes the evidence text") : fail("dropped evidence text");
}

// --- Task 4 appends the threading test below this line ---

console.log(`\n  ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
