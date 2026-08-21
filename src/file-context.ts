/**
 * file-context.ts — the judge's "files written this session" block.
 *
 * Extracted 2026-08-21 from `session-tracker.ts`, where it had been living as
 * one of THREE hand-maintained copies of the same loop (the others being
 * `dynamo-session-store.ts` and `cached-session-store.ts`).
 *
 * WHY IT IS ITS OWN MODULE NOW
 * The 0.1.530 cost cap was applied to the `session-tracker.ts` copy only.
 * That class is the in-memory DEV backend; production runs
 * `STORE_BACKEND=dynamo`, so the live path was
 * CachedSessionStore(DynamoSessionStore) and both of those kept the original
 * unbounded loop — every file written in the session, up to 2,000 chars each,
 * with no cap on file count. The cap therefore never applied in production and
 * nobody noticed for seven weeks.
 *
 * Measured cost of that divergence over 2026-07-01..08-21 (39,176 prod judge
 * calls): mean input 65,306 tokens, p99 580,918, max 624,805, growing daily as
 * long-running sessions accumulate files — one session reached 5,995 FILE rows.
 * Roughly $8.4K of Bedrock spend, and large enough to push judge responses into
 * the 512-token output cap, where a truncated reply fail-closes to `hijacked`
 * and denies legitimate work.
 *
 * So: ONE implementation, imported by all three backends. If you add a fourth
 * store, import this — do not copy the loop.
 */

/** Minimal shape this needs; each backend's FileRecord structurally satisfies it. */
export interface FileContextEntry {
  path: string;
  content: string;
  writeCount: number;
  containsCanary: boolean;
  wasReadFirst: boolean;
}

/**
 * A long session accumulates dozens of written files, so each commit-time
 * judge call shipped 40-80K tokens of uncached file content (the entire cost
 * tail). We spend a fixed total budget instead, giving security-relevant files
 * — multi-write / canary / read-then-written, the actual payload-splitting
 * indicators — first claim on it. Once the budget is spent, remaining files are
 * listed by path + flags only, so the judge still sees they exist and how they
 * were flagged.
 */
export const FILE_CONTEXT_BUDGET = {
  MAX_TOTAL_CHARS: 12_000,
  PER_FILE_CHARS: 1_000,
  MAX_FILES_LISTED: 40,
} as const;

const isFlagged = (f: FileContextEntry) => f.writeCount > 1 || f.containsCanary || f.wasReadFirst;

export function renderFileContextForJudge(files: FileContextEntry[]): string {
  if (files.length === 0) return "No files written this session.";

  const { MAX_TOTAL_CHARS, PER_FILE_CHARS, MAX_FILES_LISTED } = FILE_CONTEXT_BUDGET;

  // Stable sort (V8): flagged files first, original order kept within groups.
  const ordered = [...files].sort((a, b) => Number(isFlagged(b)) - Number(isFlagged(a)));

  let context = `FILES WRITTEN THIS SESSION (${files.length} total):\n`;
  let budget = MAX_TOTAL_CHARS;
  let omittedContent = 0;
  let listed = 0;

  for (const f of ordered) {
    // Hard ceiling on the number of per-file entries so output stays bounded
    // even for a session that writes hundreds of files — otherwise the
    // path-header list alone grows unbounded. Flagged files are sorted first,
    // so the security-relevant ones always land.
    if (listed >= MAX_FILES_LISTED) break;
    listed++;

    const flags = [
      f.writeCount > 1 ? `MULTI-WRITE(${f.writeCount}x)` : null,
      f.containsCanary ? "CONTAINS-SENSITIVE-DATA" : null,
      f.wasReadFirst ? "READ-THEN-WRITTEN" : null,
    ]
      .filter(Boolean)
      .join(", ");

    context += `\n--- ${f.path} ${flags ? `[${flags}]` : ""} ---\n`;

    if (budget <= 0) {
      context += "(content omitted — file-context budget reached)\n";
      omittedContent++;
      continue;
    }

    const take = Math.min(PER_FILE_CHARS, budget, f.content.length);
    context += f.content.substring(0, take);
    if (f.content.length > take) context += "\n... (truncated)";
    context += "\n";
    budget -= take;
  }

  const notListed = files.length - listed;
  if (omittedContent > 0 || notListed > 0) {
    const parts: string[] = [];
    if (omittedContent > 0) parts.push(`${omittedContent} listed by path+flags only`);
    if (notListed > 0) parts.push(`${notListed} not shown`);
    context += `\n(${parts.join(", ")} — file-context budget reached)\n`;
  }

  return context;
}
