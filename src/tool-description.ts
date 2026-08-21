/**
 * tool-description.ts — how a tool call is rendered for the judge and for the
 * drift detector.
 *
 * These were ONE function (`PreToolInterceptor.describeToolCall`) whose output
 * was used for three different purposes: the drift embedding, the judge's
 * `<action>` block, and the `ACTIONS TAKEN SO FAR` history entries. Bash was
 * capped at 200 characters, cut mid-token, with nothing marking that anything
 * had been removed.
 *
 * WHY THAT WAS A PROBLEM
 * Measured over 65,961 recorded Bash rows: 35,397 (53.7%) exceed 200 chars, and
 * the MEDIAN Bash command is 221 — just past the cap. So on more than half of
 * Bash calls the judge was adjudicating a fragment, and it did not know it was
 * a fragment.
 *
 * A real false positive it caused (session 58b0899e, TOOL#0022#0001, a
 * 1,129-char command): the judge saw the command stop at
 * `aws configure export-credentials --format en` and returned `hijacked`,
 * reasoning explicitly about `'en'` as though it were a real token. The removed
 * remainder was the exculpatory half — a credential PREFLIGHT
 * (export creds -> get-caller-identity -> proceed).
 *
 * Note the deterministic layer was never affected: `evaluateToolPolicy`
 * receives the RAW input, so DENIED_BASH_PATTERNS and
 * checkDangerousCombination always saw the whole command. The exposure was
 * confined to the semantic layers.
 *
 * WHY TWO FUNCTIONS AND NOT ONE BIGGER CAP
 * The drift detector embeds this same string, and the similarity thresholds
 * (0.2 / 0.3 / 0.5) were calibrated against 200-char descriptions. Widening
 * that string — or even appending a truncation marker to it — silently
 * re-scales every similarity score in the pipeline. So:
 *
 *   describeToolCall          frozen. 200 chars, no marker. Drift only.
 *   describeToolCallForJudge  2,000 chars, explicit marker. Judge only.
 *
 * If you change `describeToolCall`, you are changing drift calibration. Don't,
 * without re-deriving the thresholds.
 */

/** Judge-facing cap for a Bash command. ~p90 of real commands is 918 chars, so
 *  this covers the overwhelming majority outright; at ~500 tokens it is
 *  negligible against a judge prompt that is thousands of tokens regardless. */
export const JUDGE_ACTION_MAX_CHARS = 2_000;

/** Drift-facing cap. FROZEN — see the header. */
export const DRIFT_ACTION_MAX_CHARS = 200;

/**
 * Truncate, and SAY SO. The marker is the point of this module, more than the
 * larger window is: a silent cut invites the reader to treat the boundary as
 * meaningful, which is precisely how `--format en` became evidence of
 * credential extraction. Naming the original length also tells the judge the
 * scale of what it cannot see.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.substring(0, max)}… [TRUNCATED — showing first ${max} of ${text.length} chars]`;
}

function render(tool: string, input: Record<string, unknown>, bashMax: number, mark: boolean): string {
  const cut = (s: string, max: number) => (mark ? clip(s, max) : s.substring(0, max));
  switch (tool) {
    case "Read":
      return `Read file: ${input.file_path}`;
    case "Write":
      return `Write file: ${input.file_path} with content about ${cut(String(input.content ?? ""), 100)}`;
    case "Edit":
      return `Edit file: ${input.file_path}`;
    case "Bash":
      return `Execute command: ${cut(String(input.command ?? ""), bashMax)}`;
    case "Glob":
      return `Find files matching: ${input.pattern}`;
    case "Grep":
      return `Search for: ${input.pattern}`;
    default:
      return `${tool}: ${cut(JSON.stringify(input), bashMax)}`;
  }
}

/**
 * FROZEN rendering used for the drift embedding. Byte-identical to the
 * pre-2026-08-21 behaviour, deliberately including the silent truncation —
 * the thresholds depend on this exact shape.
 */
export function describeToolCall(tool: string, input: Record<string, unknown>): string {
  return render(tool, input, DRIFT_ACTION_MAX_CHARS, false);
}

/** Judge-facing rendering: wider window, and truncation is explicit. */
export function describeToolCallForJudge(tool: string, input: Record<string, unknown>): string {
  return render(tool, input, JUDGE_ACTION_MAX_CHARS, true);
}

/**
 * One entry in the judge's `ACTIONS TAKEN SO FAR` list. The 80-char cap stays —
 * it is a five-item summary and should remain cheap — but it stops being
 * silent, for the same reason as above.
 */
export function describeHistoryEntryForJudge(tool: string, input: Record<string, unknown>): string {
  return `${tool}(${clip(describeToolCall(tool, input), 80)})`;
}
