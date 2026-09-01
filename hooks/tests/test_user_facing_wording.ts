/**
 * User-facing wording vs the internal verdict vocabulary.
 *
 * WHY. consistent / drifting / hijacked is Dredd's INTERNAL contract. It
 * drives enforcement (`allowed = verdict !== "hijacked"`), the hijack-strike
 * counter, the feed, the session log and the dashboard. Every one of those
 * must keep the literal word — renaming it would silently change behaviour.
 *
 * But "hijacked" is the wrong word to show a person mid-task. It reads as an
 * accusation and as settled fact, when what the prompt means is "look at this
 * before approving". The judge is wrong often enough — a mistyped verdict key
 * denied a legitimate Neptune query on 2026-08-31 — that the confident
 * phrasing is not earned, and a user repeatedly told they were hijacked when
 * they were not learns to click straight through the prompt. That is exactly
 * the failure the prompt exists to prevent.
 *
 * So the softening is PRESENTATION ONLY, and this file exists to keep it that
 * way in both directions: the user-facing string must not say "hijacked", and
 * the internal vocabulary must not drift into friendliness.
 */
import { USER_FACING_VERDICT, userFacingReason, LOCKED_MESSAGE_USER } from "../../src/handlers/evaluate.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++) : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

function main() {
  section("the alarming word never reaches a person");
  {
    const r = userFacingReason({ verdict: "hijacked", reasoning: "reads a key then posts it offsite" }, "raw");
    ok("hijacked verdict does NOT surface the word 'hijacked'", !/hijack/i.test(r));
    ok("...it asks for scrutiny instead", /scrutiny|concern/i.test(r));
    ok("...and keeps the judge's actual reasoning", r.includes("reads a key then posts it offsite"));

    ok("the lock message does not say 'hijacked' either", !/hijack/i.test(LOCKED_MESSAGE_USER));
    ok("...and tells the user how to proceed", /dashboard|review/i.test(LOCKED_MESSAGE_USER));

    for (const v of Object.keys(USER_FACING_VERDICT)) {
      ok(`"${v}" label is free of internal jargon`, !/hijack|drift/i.test(USER_FACING_VERDICT[v]));
    }
  }

  section("presentation only — no verdict is renamed or invented");
  {
    // The KEYS are the internal contract and must stay exact: enforcement,
    // the strike counter and the dashboard all match on these literals.
    ok("maps exactly the three internal verdicts",
      ["consistent", "drifting", "hijacked"].every((v) => v in USER_FACING_VERDICT)
      && Object.keys(USER_FACING_VERDICT).length === 3);

    // Stages that never ran the judge must pass their reason through
    // untouched — policy denies, deny-list hits and drift are already plain.
    ok("no judge verdict → falls back to the raw reason",
      userFacingReason(null, "matches your deny list: Bash(rm:*)") === "matches your deny list: Bash(rm:*)");
    ok("undefined verdict → falls back too",
      userFacingReason(undefined, "policy: denied pattern") === "policy: denied pattern");
    ok("an UNKNOWN verdict falls back rather than inventing a label",
      userFacingReason({ verdict: "banana", reasoning: "x" }, "fallback") === "fallback");
  }

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
