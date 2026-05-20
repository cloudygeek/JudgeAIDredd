/**
 * Tests for detectAssistantOptionPick — the prior-assistant-aware
 * option-pick detector that promotes short menu-picks to the
 * confirmation path. Lives in src/intent-stack.ts; pure function so
 * no server fixture needed.
 *
 * Run: npx tsx hooks/tests/test_intent_option_pick.ts
 */

import { detectAssistantOptionPick } from "../../src/intent-stack.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

const NUMBERED_MENU = `
Want me to take one of these approaches?
1. Write the tests first
2. Deploy to staging
3. Skip and call it done
`;

const BULLETED_MENU = `
A few options:
- Write the tests first
- Deploy to staging
- Skip and move on
`;

const NO_MENU = `Let me think about this. I'll proceed in a moment.`;

function assert(cond: boolean, name: string) {
  if (cond) pass(name);
  else fail(name);
}

// =============================================================================
section("Numeric picks");

assert(detectAssistantOptionPick("1", NUMBERED_MENU), "'1' picks option 1");
assert(detectAssistantOptionPick("2", NUMBERED_MENU), "'2' picks option 2");
assert(detectAssistantOptionPick("3", NUMBERED_MENU), "'3' picks option 3");
assert(detectAssistantOptionPick("let's do 2", NUMBERED_MENU), "'let's do 2' picks option 2");
assert(detectAssistantOptionPick("yes 1 please", NUMBERED_MENU), "'yes 1 please' picks option 1");
// Out of menu range — 5 doesn't exist
assert(!detectAssistantOptionPick("5", NUMBERED_MENU), "'5' rejected when menu has only 3");
// Year-like sequence — not a pick
assert(!detectAssistantOptionPick("2026", NUMBERED_MENU), "'2026' isn't a pick");

// =============================================================================
section("Ordinal picks");

assert(detectAssistantOptionPick("the first one", NUMBERED_MENU), "'the first one'");
assert(detectAssistantOptionPick("second", NUMBERED_MENU), "'second'");
assert(detectAssistantOptionPick("third option please", NUMBERED_MENU), "'third option please'");
assert(detectAssistantOptionPick("3rd", NUMBERED_MENU), "'3rd'");

// =============================================================================
section("Token-overlap picks");

assert(detectAssistantOptionPick("write tests", NUMBERED_MENU), "'write tests' overlaps option 1");
assert(detectAssistantOptionPick("deploy staging", NUMBERED_MENU), "'deploy staging' overlaps option 2");
assert(detectAssistantOptionPick("write tests", BULLETED_MENU), "token overlap works on bulleted menus too");

// =============================================================================
section("Disqualifications");

assert(!detectAssistantOptionPick("can you do 2 instead?", NUMBERED_MENU), "leading 'can' rejects (question)");
assert(!detectAssistantOptionPick("what does option 1 actually do?", NUMBERED_MENU), "leading 'what' rejects");
assert(!detectAssistantOptionPick("how about option 3", NUMBERED_MENU), "leading 'how' rejects");
assert(!detectAssistantOptionPick("1", NO_MENU), "no parseable menu in prior assistant — no pick");
assert(!detectAssistantOptionPick("1", null), "null prior assistant — no pick");
assert(!detectAssistantOptionPick("1", ""), "empty prior assistant — no pick");
// Long prompt — not a short reply
assert(
  !detectAssistantOptionPick(
    "I want to also rewrite the build pipeline and migrate to a new framework before doing 2",
    NUMBERED_MENU
  ),
  "long prompt rejected even if it mentions a numbered option"
);
// Single-token overlap is not enough — needs 2+
assert(!detectAssistantOptionPick("tests", NUMBERED_MENU), "single token overlap is not enough");

// =============================================================================
section("Edge cases");

assert(!detectAssistantOptionPick("", NUMBERED_MENU), "empty user prompt rejected");
assert(!detectAssistantOptionPick("   ", NUMBERED_MENU), "whitespace-only rejected");
// Parenthesised numbers
const PAREN_MENU = `
(1) Write the tests first
(2) Deploy to staging
`;
assert(detectAssistantOptionPick("1", PAREN_MENU), "(1) (2) numbering works");
// Mixed bullet + numbered — assigns sequential index to bullets
const MIXED = `
- foo bar baz
- second item with quux
`;
assert(detectAssistantOptionPick("1", MIXED), "'1' picks first bullet");
assert(detectAssistantOptionPick("2", MIXED), "'2' picks second bullet");
assert(detectAssistantOptionPick("the second one", MIXED), "ordinal on bullets");

console.log(`\n  ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
