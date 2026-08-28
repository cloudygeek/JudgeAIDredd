/**
 * Agent-team coordination prompts.
 *
 * With CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1, Claude Code delivers
 * machine-generated coordination traffic as *user turns*: a sub-agent
 * or background task finishing, or a peer session sending a message.
 * Those turns fire the UserPromptSubmit hook exactly like a typed
 * prompt, so `POST /intent` used to register them as the session's new
 * goal. Everything the agent legitimately did next was then judged
 * against a coordination artifact rather than the human's actual task,
 * and got denied. Three of 43 production denies over two weeks read
 * "the current task is receiving a completion notification from a
 * sub-agent, but the current action queries a DynamoDB session
 * table…".
 *
 * This is the same class of problem `isConfirmationPrompt` solves for
 * "yes" / "ok" / "option 2": a user turn that is not a statement of a
 * new goal must not overwrite the goal we already have.
 *
 * WHY MATCH ON TEXT
 * -----------------
 * The transcript JSONL *does* carry a clean discriminator — human
 * turns have `origin: {kind:"human"}` + `promptSource:"typed"`, these
 * have `origin.kind` of `"task-notification"` / `"peer"` (or, on
 * Claude Code ≤2.1.218, no `origin` at all). But the hook's `/intent`
 * body carries only `{session_id, prompt, cwd, transcript_path,
 * transcript_summary, …}`, and `build_transcript_summary` reduces each
 * user turn to `{text, images}`. No origin marker reaches the server,
 * so the envelope text is the only signal available here. Forwarding
 * `origin.kind` from the hook would be strictly better — see the note
 * in the task report.
 *
 * WHAT WE KEY ON
 * --------------
 * Not semantics — an exact, harness-generated frame. Claude Code emits
 * these wrappers itself; they are not model output and not something a
 * user types. Measured over every local transcript (2026-08-20):
 *
 *   - 365/365 `<task-notification>` turns both START and END with the
 *     tag pair.
 *   - 1627/1627 peer turns start with the literal sentence
 *     "Another Claude session sent a message:" and contain a
 *     `</teammate-message>` (1586) or `</agent-message>` (41) close.
 *   - 0 of 1099 turns marked `origin.kind === "human"` match either
 *     shape.
 *
 * FALSE-NEGATIVE BOUND
 * --------------------
 * A false negative here is worse than the bug: silently suppressing a
 * real goal leaves Dredd judging every later tool call against a stale
 * intent, which is both more damaging and much harder to notice. So
 * the predicate is anchored at both ends rather than merely
 * containment-based:
 *
 *   - The frame must START the prompt. "why does <teammate-message>
 *     show up in turnIntents?" is a goal, not coordination.
 *   - The closing tag must be present. A truncated or hand-pasted
 *     fragment is not trusted as machine-generated.
 *   - `<task-notification>` must also END the prompt (it always does),
 *     so a human pasting one and appending a question still registers.
 *
 * If Claude Code changes the wrapper wording, this predicate stops
 * matching and behaviour reverts to today's — noisy, but never
 * goal-suppressing. That is the safe direction to fail in.
 */

/** Sub-agent / background-task completion notification. */
const TASK_NOTIFICATION_OPEN = "<task-notification>";
const TASK_NOTIFICATION_CLOSE = "</task-notification>";

/**
 * Preamble Claude Code prepends to every inbound peer message. Stable
 * across both the `<teammate-message>` (older) and `<agent-message>`
 * (newer, `origin.kind === "peer"`) envelope shapes.
 */
const PEER_PREAMBLE = "Another Claude session sent a message:";

/** Closing tags for the two peer envelope shapes observed in the wild. */
const PEER_CLOSE_TAGS = ["</teammate-message>", "</agent-message>"];

/**
 * True when the prompt is a machine-generated agent-team coordination
 * envelope rather than a statement of intent by the user.
 */
export function isCoordinationPrompt(text: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t) return false;

  // Sub-agent / background-task completion. Anchored at both ends: the
  // envelope is the entire message in all 365 observed samples.
  if (t.startsWith(TASK_NOTIFICATION_OPEN) && t.endsWith(TASK_NOTIFICATION_CLOSE)) {
    return true;
  }

  // Peer message from another Claude session. The harness appends a
  // fixed trust caveat after the envelope, so we anchor on the preamble
  // and require the envelope to be closed rather than ending-anchoring.
  if (t.startsWith(PEER_PREAMBLE)) {
    return PEER_CLOSE_TAGS.some((tag) => t.includes(tag));
  }

  return false;
}

/**
 * Whether this prompt is allowed to mutate the session's goal (intent
 * stack + the interceptor's registered anchor).
 *
 * A coordination envelope never is — INCLUDING on a session with no
 * goal yet. An earlier exception registered anchorless coordination
 * anyway, reasoning it "cannot happen live"; production disproved that
 * on 2026-08-27 (hooks enabled mid-session → a monitor wake-up was the
 * session's first /intent → a <task-notification> blob anchored a
 * 780-call session). The judge explicitly supports an undefined intent
 * (test_judge_undefined_intent); the session stays anchorless until the
 * next real prompt, which becomes the ORIGINAL. The transcript-backfill
 * path keeps its own last-resort anchor logic (it scans many turns and
 * only ever anchors on coordination when EVERY turn is coordination).
 */
export function shouldUpdateSessionGoal(prompt: string, _hasExistingGoal: boolean): boolean {
  return !isCoordinationPrompt(prompt);
}
