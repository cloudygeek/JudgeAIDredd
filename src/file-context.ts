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
  /** Turns that modified this file. Used to order the "recent" tier by LAST
   *  write. Optional so older callers/fixtures still typecheck. */
  modifiedAtTurns?: number[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The files a command actually names — by full path, cwd-relative path, or
 * basename appearing as a TOKEN.
 *
 * This is the shared matcher: `handlers/evaluate.ts` uses it to decide whether
 * to attach file context at all, and the renderer below uses it to decide what
 * goes in it. Before, those two disagreed — the trigger asked "does this
 * command touch any written file?" and the renderer answered "here is every
 * file written this session".
 *
 * The token boundary rejects a basename glued inside a longer filename
 * (`brief.md` inside `debrief.md.bak`). `/` is deliberately a legal preceding
 * character — that is how paths are written. Measured on real traffic this
 * removes only ~1.5% of firings; it is a correctness tidy, not the point of
 * the change.
 */
export function referencedWrittenFiles<T extends { path: string }>(
  command: string,
  files: T[],
  cwd?: string | null,
): T[] {
  if (!command || files.length === 0) return [];
  const out: T[] = [];
  for (const f of files) {
    if (command.includes(f.path)) {
      out.push(f);
      continue;
    }
    // cwd-relative form: /proj/src/index.js under cwd /proj -> src/index.js
    if (cwd && f.path.startsWith(cwd.replace(/\/+$/, "") + "/")) {
      const rel = f.path.slice(cwd.replace(/\/+$/, "").length + 1);
      if (rel && command.includes(rel)) {
        out.push(f);
        continue;
      }
    }
    const base = f.path.split("/").pop();
    if (!base) continue;
    // Not preceded/followed by filename characters. `/` may precede.
    if (new RegExp(`(?<![A-Za-z0-9_.\\-])${escapeRe(base)}(?![A-Za-z0-9_\\-])`).test(command)) {
      out.push(f);
    }
  }
  return out;
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
  /** Tier caps for the scoped (command-aware) path. */
  MAX_CANARY_FILES: 5,
  MAX_RECENT_FILES: 5,
} as const;

const isFlagged = (f: FileContextEntry) => f.writeCount > 1 || f.containsCanary || f.wasReadFirst;

/** Last turn that touched this file. Map iteration order is FIRST-write, so a
 *  file written at turn 2 and rewritten at turn 400 would otherwise sort as
 *  old — and the recent tier is the only cover for commands that name nothing
 *  (`make`, `npm start`, `./run.sh`). */
const lastWrittenTurn = (f: FileContextEntry) =>
  f.modifiedAtTurns && f.modifiedAtTurns.length ? Math.max(...f.modifiedAtTurns) : -1;

export interface FileContextOptions {
  /** The command being judged. When present, output is scoped to it. */
  command?: string;
  cwd?: string | null;
}

export function renderFileContextForJudge(
  files: FileContextEntry[],
  opts?: FileContextOptions,
): string {
  if (files.length === 0) return "No files written this session.";
  if (opts?.command) return renderScoped(files, opts.command, opts.cwd ?? null);

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

/**
 * Command-scoped rendering: select by relevance to THIS command rather than by
 * flag status across the whole session.
 *
 * The tier order is the whole design. 9dafc90f sorted flagged-first across
 * every written file, and with 47% of a real session's 1,026 files carrying
 * MULTI-WRITE the 40-file window filled with arbitrary flagged files while the
 * file the command actually referenced ranked ~423 — absent entirely, not even
 * a path line. That file is the payload-splitting target this block exists to
 * carry.
 *
 *   1. REFERENCED  files the command names            — content, budget first
 *   2. SENSITIVE   containsCanary                     — content, never crowded out
 *   3. RECENT      last-written, by max(modifiedAtTurns) — content
 *   4. REST        everything else, flagged first     — path + flags, no content
 *
 * TIER 2 IS CURRENTLY DEAD, and knowing that matters more than the tier does.
 * `containsCanary` is hardcoded `false` on ALL THREE backends
 * (session-tracker.ts, dynamo-session-store.ts x2) — a leftover of the canary
 * scaffolding removed after tag `research-v1`; the field survives only for the
 * dashboard's flag rendering and old session logs. The live read-then-write
 * staging signal is computed (`checkContentFromReads`) but only console-logged,
 * never persisted, so it reaches neither this block nor the judge. The tier is
 * kept because it costs nothing and becomes correct the moment that value is
 * written onto the record — but do not read its presence as coverage.
 *
 * Tier 3 covers "wrote it, then ran it through a wrapper that does not name
 * it" — without it, scoping opens a blind spot the old dump-everything
 * behaviour accidentally covered. NOTE that when files tie on recency (e.g.
 * every write landed on the same turn) the tie breaks in the caller's Map
 * order, which differs between the in-memory and Dynamo backends. Equally
 * valid, but it means tier 3/4 MEMBERSHIP is not byte-stable across backends;
 * see hooks/tests/test_file_context_backends.ts.
 *
 * INVARIANT: a referenced file that cannot afford content is still LISTED.
 * Capping content is fine; dropping the row is the 0.1.541 defect. This bites
 * at the p90 of 64 referenced files, where only ~12 fit content.
 */
function renderScoped(files: FileContextEntry[], command: string, cwd: string | null): string {
  const { MAX_TOTAL_CHARS, PER_FILE_CHARS, MAX_CANARY_FILES, MAX_RECENT_FILES, MAX_FILES_LISTED } =
    FILE_CONTEXT_BUDGET;

  const seen = new Set<string>();
  const take = (list: FileContextEntry[], cap: number) => {
    const out: FileContextEntry[] = [];
    for (const f of list) {
      if (out.length >= cap) break;
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
    return out;
  };

  const referenced = referencedWrittenFiles(command, files, cwd);
  const tier1 = take(referenced, referenced.length); // no cap: every named file is listed
  const tier2 = take(files.filter((f) => f.containsCanary), MAX_CANARY_FILES);
  const tier3 = take(
    [...files].sort((a, b) => lastWrittenTurn(b) - lastWrittenTurn(a)),
    MAX_RECENT_FILES,
  );
  const tier4 = take([...files].sort((a, b) => Number(isFlagged(b)) - Number(isFlagged(a))), MAX_FILES_LISTED);

  const flagsOf = (f: FileContextEntry) =>
    [
      f.writeCount > 1 ? `MULTI-WRITE(${f.writeCount}x)` : null,
      f.containsCanary ? "CONTAINS-SENSITIVE-DATA" : null,
      f.wasReadFirst ? "READ-THEN-WRITTEN" : null,
    ]
      .filter(Boolean)
      .join(", ");

  let context = `FILES WRITTEN THIS SESSION (${files.length} total) — scoped to this command:\n`;
  let budget = MAX_TOTAL_CHARS;
  let withContent = 0;

  const emit = (f: FileContextEntry, label: string, allowContent: boolean) => {
    const flags = flagsOf(f);
    context += `\n--- ${f.path} [${label}${flags ? `, ${flags}` : ""}] ---\n`;
    if (!allowContent || budget <= 0) {
      context += "(content omitted — file-context budget reached)\n";
      return;
    }
    const n = Math.min(PER_FILE_CHARS, budget, f.content.length);
    context += f.content.substring(0, n);
    if (f.content.length > n) context += "\n... (truncated)";
    context += "\n";
    budget -= n;
    withContent++;
  };

  for (const f of tier1) emit(f, "REFERENCED BY THIS COMMAND", true);
  for (const f of tier2) emit(f, "SENSITIVE", true);
  for (const f of tier3) emit(f, "RECENTLY WRITTEN", true);
  for (const f of tier4) emit(f, "also written", false);

  // Always present, so the judge can never mistake a scoped block for a
  // complete one — and knows the scale of what it is not seeing.
  const multi = files.filter((f) => f.writeCount > 1).length;
  const readThen = files.filter((f) => f.wasReadFirst).length;
  const canary = files.filter((f) => f.containsCanary).length;
  context +=
    `\n(${files.length} files written this session: ${multi} multi-write, ` +
    `${readThen} read-then-written, ${canary} sensitive. ` +
    `Showing ${tier1.length} referenced by this command, ${tier2.length} sensitive, ` +
    `${tier3.length} recent, ${tier4.length} more by path only; ` +
    `${withContent} with content. This block is SCOPED — files not listed were written but not named by this command.)\n`;

  return context;
}
