/**
 * Cold-start goal selection must skip agent-team coordination envelopes.
 *
 * `isCoordinationPrompt` (2026-08-20) stops coordination turns overwriting the
 * session goal on the LIVE path, via /intent. But the cold-container BACKFILL
 * path picks its goal separately: transcript-backfill walks user turns
 * newest -> oldest and takes the first NON-CONFIRMATION prompt. A
 * `<task-notification>` or peer-message envelope is not a confirmation, so on
 * a fresh container mid-session the reconstructed goal could be a coordination
 * artifact — the same bug the live-path fix closes, on the redeploy path.
 *
 * That matters more than it sounds: the backfilled goal is what the judge
 * anchors on for the rest of the session, so every later tool call would be
 * scored against a machine-generated notification instead of the human's task.
 *
 * The predicate stays anchored (frame at both ends), so a human turn that
 * merely MENTIONS an envelope tag is still selected as the goal.
 *
 * Run: npx tsx hooks/tests/test_backfill_coordination.ts
 */

import { extractLastUserAndPriorAssistant } from "../../src/transcript-backfill.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++) : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

const HUMAN_GOAL = "Fix the DynamoDB session query and redeploy the hook";

const TASK_NOTIFICATION =
  "<task-notification>\n<task-id>bjhi2kjaj</task-id>\n<status>completed</status>\n</task-notification>";

const PEER_MESSAGE =
  'Another Claude session sent a message:\n<teammate-message teammate_id="fix-item-size" color="purple">\n' +
  '{"type":"idle_notification","from":"fix-item-size"}\n</teammate-message>\n';

/**
 * Run the extractor over a synthetic transcript whose user turns are
 * `prompts`, oldest first. Uses the isContent=true overload — the path form
 * goes through safeServerReadablePath, which correctly rejects a tmpdir.
 */
function goalFrom(prompts: string[]): string | null {
  const jsonl = prompts
    .map((p) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: p }] } }))
    .join("\n");
  return extractLastUserAndPriorAssistant(jsonl, true).lastUser;
}

function main() {
  section("sanity — the harness parses turns at all (passes before AND after)");
  ok("a lone human turn is extracted", goalFrom([HUMAN_GOAL]) === HUMAN_GOAL);
  ok("the newest human turn wins", goalFrom([HUMAN_GOAL, "check the latest logs"]) === "check the latest logs");
  ok("an empty transcript yields null", goalFrom([]) === null);
  ok("a confirmation is skipped (existing behaviour)", goalFrom([HUMAN_GOAL, "yes"]) === HUMAN_GOAL);

  section("coordination envelopes are skipped when picking the backfilled goal");
  ok("task-notification is not chosen", goalFrom([HUMAN_GOAL, TASK_NOTIFICATION]) !== TASK_NOTIFICATION);
  ok("...the human goal is chosen instead", goalFrom([HUMAN_GOAL, TASK_NOTIFICATION]) === HUMAN_GOAL);
  ok("peer message is not chosen", goalFrom([HUMAN_GOAL, PEER_MESSAGE]) !== PEER_MESSAGE);
  ok("...the human goal is chosen instead", goalFrom([HUMAN_GOAL, PEER_MESSAGE]) === HUMAN_GOAL);
  ok(
    "walks back past a burst of envelopes AND a confirmation",
    goalFrom([HUMAN_GOAL, PEER_MESSAGE, TASK_NOTIFICATION, PEER_MESSAGE, "yes"]) === HUMAN_GOAL,
  );

  section("human turns still win — no goal suppression");
  const mentions = "why does </teammate-message> keep showing up in turnIntents?";
  ok("a human turn MENTIONING an envelope tag is still selected", goalFrom([HUMAN_GOAL, mentions]) === mentions);
  const quoted = "I got a <task-notification> in my terminal — what does status=failed mean?";
  ok("a human turn QUOTING a tag is still selected", goalFrom([HUMAN_GOAL, quoted]) === quoted);

  section("degenerate case — never leave the judge anchorless");
  ok("a transcript of ONLY coordination still yields a goal", goalFrom([PEER_MESSAGE, TASK_NOTIFICATION]) !== null);

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
