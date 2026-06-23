/**
 * Regression test for the prod judge fail-soft bug (found 2026-06-23).
 *
 * Root cause: an undefined intent prompt produced IntentEntry.contextual =
 * undefined, which crashed IntentJudge.evaluate at scrubFenceTags(undefined)
 * .replace() ("Cannot read properties of undefined (reading 'replace')"),
 * was caught by evaluate()'s try/catch, and failed the judge SOFT
 * (verdict=drifting → silent ALLOW). ~3.7% of prod judge calls over 30 days.
 *
 * Covers the three fixes:
 *   1a. buildContextualIntent never returns undefined (the proven source).
 *   1b. scrubFenceTags tolerates a non-string (the crash site / backstop).
 *   2.  isUsableGoalText gates backfill registration so an unrecoverable
 *       prompt drops to policy-only instead of registering an empty goal
 *       (which would give the judge nothing to evaluate against).
 *
 * Run: npx tsx hooks/tests/test_judge_undefined_intent.ts
 * Exits non-zero on any failure.
 */

import { buildContextualIntent } from "../../src/transcript-backfill.js";
import { scrubFenceTags, isInternalJudgeError, failVerdictFor } from "../../src/intent-judge.js";
import { isUsableGoalText } from "../../src/intent-stack.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
// Run fn() and check its result; a throw is recorded as a failure (not abort).
function check<T>(label: string, fn: () => T, ok: (v: T) => boolean): void {
  try {
    const v = fn();
    ok(v) ? pass(label) : fail(`${label} (got ${JSON.stringify(v)})`);
  } catch (e: any) {
    fail(`${label} (threw: ${e?.message})`);
  }
}

console.log("\n--- Fix 1a: buildContextualIntent never returns undefined ---");
check("buildContextualIntent(undefined, null) returns a string",
  () => buildContextualIntent(undefined as any, null), (v) => typeof v === "string");
check("buildContextualIntent(undefined, prior) returns a string",
  () => buildContextualIntent(undefined as any, "some prior assistant text"), (v) => typeof v === "string");
check("normal prompt (no prior) passes through unchanged",
  () => buildContextualIntent("fix the typo in README", null), (v) => v === "fix the typo in README");

console.log("\n--- Fix 1b: scrubFenceTags tolerates a non-string ---");
check("scrubFenceTags(undefined) returns '' without throwing",
  () => scrubFenceTags(undefined as any), (v) => v === "");
check("scrubFenceTags still redacts fence tags (regression)",
  () => scrubFenceTags("<user_intent>x</user_intent>"), (v) => v === "[REDACTED:fence-tag]x[REDACTED:fence-tag]");

console.log("\n--- Fix 2: isUsableGoalText gates empty/undefined goal prompts ---");
check("isUsableGoalText(undefined) === false", () => isUsableGoalText(undefined), (v) => v === false);
check("isUsableGoalText(null) === false", () => isUsableGoalText(null), (v) => v === false);
check("isUsableGoalText('') === false", () => isUsableGoalText(""), (v) => v === false);
check("isUsableGoalText(whitespace) === false", () => isUsableGoalText("   \n\t "), (v) => v === false);
check("isUsableGoalText('real goal') === true", () => isUsableGoalText("real goal"), (v) => v === true);

console.log("\n--- Fix 3: a code bug fails CLOSED (ask/deny), a Bedrock outage fails OPEN ---");
// isInternalJudgeError: programmer-error classes = code bug; everything else = availability.
check("isInternalJudgeError(TypeError) === true", () => isInternalJudgeError(new TypeError("x")), (v) => v === true);
check("isInternalJudgeError(ReferenceError) === true", () => isInternalJudgeError(new ReferenceError("x")), (v) => v === true);
check("isInternalJudgeError(RangeError) === true", () => isInternalJudgeError(new RangeError("x")), (v) => v === true);
check("isInternalJudgeError(generic Bedrock Error) === false", () => isInternalJudgeError(new Error("ThrottlingException: rate exceeded")), (v) => v === false);
check("isInternalJudgeError(string) === false", () => isInternalJudgeError("nope"), (v) => v === false);
check("isInternalJudgeError(null) === false", () => isInternalJudgeError(null), (v) => v === false);
// failVerdictFor: code bug → internalError flag (drives fail-closed); outage → fail-soft drifting (fail-open).
check("failVerdictFor(TypeError) sets internalError=true (fail-closed)",
  () => failVerdictFor(new TypeError("boom")), (v) => v.internalError === true && v.verdict === "drifting");
check("failVerdictFor(TypeError) reasoning marks it fail-closed",
  () => failVerdictFor(new TypeError("boom")), (v) => /fail-closed/i.test(v.reasoning));
check("failVerdictFor(Bedrock outage) does NOT set internalError (fail-open)",
  () => failVerdictFor(new Error("Bedrock timeout")), (v) => !v.internalError && v.verdict === "drifting");
check("failVerdictFor(Bedrock outage) reasoning marks it fail-soft",
  () => failVerdictFor(new Error("Bedrock timeout")), (v) => /fail-soft/i.test(v.reasoning));

console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off}  (${PASS} passed, ${FAIL} failed)\n`);
process.exit(FAIL === 0 ? 0 : 1);
