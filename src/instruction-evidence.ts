/**
 * Instruction-load judge evidence.
 *
 * Instruction files (CLAUDE.md / .claude/rules/*.md) are a goal-hijack
 * channel: a malicious or compromised repo's CLAUDE.md can silently
 * redirect the agent, and the judge — which runs in clean context with no
 * agent history — never sees them. The InstructionsLoaded hook records
 * each load onto the session; this module renders that record into a
 * compact, deterministic evidence body the judge can weigh when
 * DREDD_INSTRUCTIONS_EVIDENCE_ENABLED is on.
 *
 * Pure + side-effect free (mirrors provenance-taint.ts) so it's trivially
 * testable. The server wraps the body in a server-trusted block via
 * renderInstructionsBlock in intent-judge.ts — same injection pattern as
 * <provenance_alert> and <prior_approvals>.
 */

import type { InstructionLoadRecord } from "./session-types.js";

export interface InstructionEvidence {
  /** Evidence body (no fence tags). Empty string when there's nothing to
   *  report — callers can prepend it unconditionally. */
  text: string;
  /** Distinct instruction files after path-dedup. */
  count: number;
  /** Short one-line summary for telemetry / the dashboard chip. */
  topSummary: string;
}

const EMPTY: InstructionEvidence = { text: "", count: 0, topSummary: "" };

/**
 * Build judge evidence from a session's instruction-load records.
 * Dedupes by path (a file reloaded across compaction shouldn't bloat the
 * block), keeping the most recent reason/turn for each. Returns EMPTY when
 * there are no loads.
 */
export function buildInstructionEvidence(
  loads: InstructionLoadRecord[] | undefined | null,
): InstructionEvidence {
  if (!loads || loads.length === 0) return EMPTY;

  // loads is oldest-first; later writes win so each path carries its most
  // recent reason/turn. Map preserves first-seen (oldest-first) order,
  // which reads naturally: the session-start CLAUDE.md leads, nested files
  // follow.
  const byPath = new Map<string, InstructionLoadRecord>();
  for (const l of loads) {
    if (l && typeof l.path === "string" && l.path) byPath.set(l.path, l);
  }
  const distinct = Array.from(byPath.values());
  if (distinct.length === 0) return EMPTY;

  const lines = distinct.map(
    (l, i) => `${i + 1}. ${l.path} (loaded: ${l.reason || "unspecified"}, turn ${l.turn})`,
  );

  return {
    count: distinct.length,
    text: lines.join("\n"),
    topSummary: `${distinct.length} instruction file(s); incl. ${distinct[0].path}`.slice(0, 200),
  };
}
