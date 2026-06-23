/**
 * Interactive/learn intent stack.
 *
 * In interactive (and learn) mode, the user can submit a prompt while
 * the agent is still working on the previous one. Claude Code combines
 * queued prompts at the next generation boundary, so the judge has to
 * authorise tool calls against ALL active goals — not just the most
 * recent. This module implements that stack:
 *
 *   1. classify each /intent (confirmation / queued / new-task /
 *      continuation / sub-task / replacement / revisit)
 *   2. mutate the stack accordingly (append / push / clear-resolved /
 *      revive / supersede)
 *   3. write the stack back via the SessionStore and re-sync the drift
 *      detector via setActiveIntents()
 *
 * Plus the transcript-summary + JSONL backfill paths used by /evaluate
 * when state has been lost (container restart, fresh deployment) and
 * the intent stack needs to be reconstructed from what the agent has
 * already done.
 *
 * Extracted from server-core.ts. tracker + interceptor are imported
 * back from server-core (circular, but the reference is lazy — the
 * import binding is read at function call time, well after server-core
 * has finished initialising).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { embedAny, cosineSimilarity } from "./ollama-client.js";
import type { ImageBlock, IntentEntry } from "./session-types.js";
import {
  MAX_ACTIVE_INTENTS,
  RESOLVED_INTENT_TTL_MS,
} from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import {
  buildContextualIntent,
  extractTextAndImages,
  isSyntheticUserEntry,
  extractLastUserAndPriorAssistant,
} from "./transcript-backfill.js";
import {
  tracker,
  interceptor,
  CONFIG,
  safeServerReadablePath,
  registeredSessions,
} from "./server-core.js";

// =============================================================================
// Interactive/learn intent stack
// =============================================================================
//
// In interactive (and learn) mode, the user can submit a prompt while the
// agent is still working on the previous one. Claude Code combines queued
// prompts at the next generation boundary, so the judge has to authorise
// tool calls against ALL active goals — not just the most recent. The stack
// implements that.
//
// We classify each /intent into one of:
//   - confirmation       short ack ("yes", "ok", "option 2")
//   - queued / open      arrived during DRAINING (or OPEN) — append
//   - new-task           closed-state, low similarity to top of stack — clear resolved, push
//   - continuation       closed-state, high similarity — push, keep prior
//
// The hook calls applyIntentStackUpdate() which:
//   1. derives turnState from the timing markers,
//   2. classifies the prompt,
//   3. mutates the stack accordingly,
//   4. writes the stack back to the store and re-syncs the drift detector
//      via setActiveIntents().
//
// CONFIDENCE THRESHOLDS:
//   continuation_max_drift = 0.30   action embedding-similar enough to
//                                   the existing stack top — refinement
//   new_task_min_drift     = 0.50   topic switch — wipe resolved, push
// Everything in 0.30–0.50 (the "ambiguous middle") defaults to append
// without clearing resolved entries. This is the conservative choice — we
// keep the prior intent visible to the judge so a follow-up that turns
// out to BE the prior task isn't suddenly judged in isolation.

export const CONTINUATION_DRIFT_MAX = 0.30;
export const NEW_TASK_DRIFT_MIN = 0.50;

/**
 * Drift threshold for suspecting a sub-task. When the drift to the
 * top of the live stack is in the (CONTINUATION_DRIFT_MAX,
 * SUB_TASK_DRIFT_MAX] range AND structural cues fire (phrasing
 * pattern, parent-relation), classify as "sub-task" rather than
 * "continuation". Below this we treat as continuation; above this we
 * fall through to the topic-switch / replacement path.
 *
 * Empirically chosen at the midpoint between continuation (clearly
 * the same goal) and new-task (clearly different); step 4 telemetry
 * will tune.
 */
export const SUB_TASK_DRIFT_MAX = 0.40;

/**
 * Cosine *similarity* threshold used by the revisit classifier. When
 * a non-active historical entry's embedding has similarity >= this
 * value to the new prompt AND a phrasing pattern fires, classify as
 * revisit. Set high (0.65) because false-positive revisits are
 * expensive — we'd revive a stale goal and redirect the judge to it.
 *
 * Equivalent drift: 1 - 0.65 = 0.35. So the historical entry must be
 * meaningfully closer than the CONTINUATION_DRIFT_MAX boundary; not
 * just "vaguely similar topic", but "this looks like the same prior
 * goal I'm being asked to resume".
 */
export const REVISIT_SIMILARITY_MIN = 0.65;

/**
 * Phrasing patterns that strongly signal the user is returning to a
 * prior goal. The classifier requires BOTH a phrasing match AND a
 * historical-entry similarity above REVISIT_SIMILARITY_MIN before
 * classifying as revisit. Either signal alone is too weak: phrasing
 * without historical context could be a new task ("let's go back to
 * what we were saying — actually wait, do this instead"); high
 * similarity without phrasing might just be coincidental topic
 * overlap.
 *
 * Conservative starting set — step 4 telemetry will inform expansion.
 */
const REVISIT_PHRASING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgo\s+back\s+to\b/i,
  /\breturn\s+to\b/i,
  /\bback\s+to\s+(?:the|that|fixing|building|reviewing|working)\b/i,
  /\blet'?s\s+(?:resume|finish|continue\s+with)\b/i,
  /\bresume\s+(?:the|that|fixing|building)\b/i,
  /\bnow\s+back\s+to\b/i,
  /\bpick\s+up\s+(?:the|that|where)\b/i,
];

/**
 * Phrasing patterns that signal the new prompt SUPERSEDES an existing
 * active goal. "actually do X instead", "no wait, do Y" — the user is
 * replacing what they were just doing rather than continuing or
 * branching. Combined with mid-band drift to the top of the active
 * stack, these promote a "continuation" to a "replacement" and mark
 * the previous entry resolved.
 */
const REPLACEMENT_PHRASING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bactually\s+(?:do|make|build|fix|use|try)\b/i,
  /\binstead\s+of\b/i,
  /\b(?:no|wait|cancel)\s*[,.]?\s+(?:do|let'?s|fix|make)\b/i,
  /\bforget\s+(?:that|it)\b/i,
  /\bnever\s+mind\b/i,
  /\bscrap\s+(?:that|it)\b/i,
  /\b(?:do|make|fix)\s+\S+\s+instead\b/i,
];

/**
 * Phrasing patterns that signal a child task scoped under the active
 * goal. "first add tests", "before that, fix X", "on the way, let's
 * also Y". Combined with mid-band drift, these indicate sub-task
 * rather than continuation: parent stays live, child is added.
 */
const SUB_TASK_PHRASING_PATTERNS: ReadonlyArray<RegExp> = [
  /\bfirst\s+(?:add|fix|build|let'?s|i'?ll|i\s+want|create)\b/i,
  /\bbefore\s+(?:that|we)\b/i,
  /\bon\s+the\s+way\b/i,
  /\bquick(?:ly)?\s+(?:add|fix|do|tweak)\b/i,
  /\bjust\s+(?:add|fix|do|tweak)\s+\S+\s+(?:then|first)\b/i,
  /\bsmall\s+(?:thing|tweak|fix|change)\s+(?:first|before)\b/i,
];

/** Match any of a pattern set against a prompt. */
function matchesAny(prompt: string, patterns: ReadonlyArray<RegExp>): boolean {
  for (const re of patterns) {
    if (re.test(prompt)) return true;
  }
  return false;
}

/**
 * Diagnostic helper for the LLM-override path. Reports which
 * phrasing patterns the prompt matched against and which it didn't,
 * so that when the LLM overrides the embedding's kind we can see
 * whether the embedding missed because of a phrasing-pattern gap
 * (the pattern set needs expansion) or because the drift was
 * misclassified (the threshold needs tuning).
 *
 * Returned as a short string so it can be logged inline; the full
 * structured form is kept in the feed entry for dashboard
 * aggregation.
 */
export function describePhrasingMatches(prompt: string): {
  revisit: boolean;
  replacement: boolean;
  subTask: boolean;
} {
  return {
    revisit: matchesAny(prompt, REVISIT_PHRASING_PATTERNS),
    replacement: matchesAny(prompt, REPLACEMENT_PHRASING_PATTERNS),
    subTask: matchesAny(prompt, SUB_TASK_PHRASING_PATTERNS),
  };
}

// ---------------------------------------------------------------------------
// Assistant-option-pick detector.
//
// Catches the case where the assistant offered a structured menu and
// the user replies with the pick — "1", "the second one", "option B
// please", "let's do tests". The confirmation regex misses these
// because the user typed an arbitrary token; the embedding classifier
// either misfires as new-task (short prompt, noisy embedding) or
// reaches the short-prompt guard and demotes to continuation, which
// doesn't actually carry the user's intent forward.
//
// When this returns true the caller treats the prompt as a
// confirmation of the prior assistant turn — exactly the existing
// confirmation path that adopts the assistant proposal as the new
// stack top. Feed logs the trigger reason "assistant-option-pick"
// so we can measure how often it fires.

const ORDINAL_WORDS = new Set([
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th",
]);

// Question/imperative starts that disqualify the prompt as a pick —
// these are new requests, not selections.
const NON_PICK_LEAD = /^\s*(what|how|why|when|where|who|which|can|could|should|do|does|is|are|will|would|please)\b/i;

interface MenuOption {
  /** 1-based index as it appeared in the menu. */
  index: number;
  /** Trimmed text of the option line. */
  text: string;
}

/** Light tokenisation for overlap matching. Lowercase, alpha-num
 *  words, dropped if shorter than 3 chars (drops "the", "to", etc). */
function pickTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

/** Parse numbered / bulleted options from prior assistant text. Looks
 *  for line-starts like "1.", "1)", "(1)", "- ", "* ". Returns up to
 *  10 options — beyond that we're probably not looking at a menu. */
function parseMenu(priorAssistant: string): MenuOption[] {
  const lines = priorAssistant.split("\n");
  const out: MenuOption[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Numbered: "1.", "2)", "(3)", "[4]" optionally followed by a space.
    let m = line.match(/^[\[(]?\s*(\d{1,2})\s*[\])\.\):]\s*(.+)$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (idx >= 1 && idx <= 20) {
        out.push({ index: idx, text: m[2].trim() });
        continue;
      }
    }
    // Bulleted: "- foo", "* foo", "• foo" — assign a sequential index.
    m = line.match(/^[-*•]\s+(.+)$/);
    if (m) {
      out.push({ index: out.length + 1, text: m[1].trim() });
      continue;
    }
  }
  return out.slice(0, 10);
}

/**
 * Returns true when `userPrompt` looks like the user picking from a
 * menu in `priorAssistant`. Conservative — only fires when:
 *   - prompt is ≤ 40 chars (short reply)
 *   - prompt doesn't start with a question / imperative word
 *   - assistant text contains a parseable numbered or bulleted list
 *   - AND at least one of: numeric pick within list size, ordinal
 *     word, or ≥2 content-word overlap with one of the options
 */
export function detectAssistantOptionPick(
  userPrompt: string,
  priorAssistant: string | null,
): boolean {
  if (!priorAssistant) return false;
  const trimmed = userPrompt.trim();
  if (!trimmed || trimmed.length > 40) return false;
  if (NON_PICK_LEAD.test(trimmed)) return false;

  const options = parseMenu(priorAssistant);
  if (options.length === 0) return false;

  // Numeric pick — "1", "yes 2", "let's do 3". Cap at 9 so a year or
  // long number doesn't mis-fire.
  const numMatch = trimmed.match(/(?<![\d.])\b([1-9])\b(?![\d.])/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (options.some((o) => o.index === n)) return true;
  }

  // Ordinal pick — "the first", "second one", "third option".
  const ordTokens = trimmed.toLowerCase().split(/\s+/);
  for (const tok of ordTokens) {
    const clean = tok.replace(/[^\w]/g, "");
    if (ORDINAL_WORDS.has(clean)) return true;
  }

  // Token-overlap with any option line. Two or more content words in
  // common signals "let's do <option phrasing>" type picks.
  const userTokens = pickTokens(trimmed);
  if (userTokens.size === 0) return false;
  for (const opt of options) {
    const optTokens = pickTokens(opt.text);
    let overlap = 0;
    for (const t of userTokens) {
      if (optTokens.has(t)) overlap++;
      if (overlap >= 2) return true;
    }
  }
  return false;
}

export type TurnState = "open" | "draining" | "closed";

export function deriveTurnState(prev: {
  prevUserPromptAt: number;
  prevPreToolUseAt: number;
  prevStopAt: number;
}): TurnState {
  // Stop is the boundary between turns. Anything earlier than the most
  // recent Stop is "from the previous turn" and doesn't influence state.
  const preToolSinceStop = prev.prevPreToolUseAt > prev.prevStopAt;
  const userPromptSinceStop = prev.prevUserPromptAt > prev.prevStopAt;

  if (!userPromptSinceStop && !preToolSinceStop) {
    // Fresh session OR previous turn fully completed (Stop fired). The
    // incoming prompt is the start of a new turn.
    return "closed";
  }
  if (preToolSinceStop) {
    // The agent has fired at least one PreToolUse since the last Stop —
    // it's mid-execution. The new prompt is queued.
    return "draining";
  }
  // User submitted a prompt since the last Stop, but no PreToolUse has
  // fired since — the LLM is generating but hasn't called a tool yet, OR
  // the user fired two prompts back-to-back before the LLM responded.
  // Either way, the new prompt is open-followup; the LLM will combine.
  return "open";
}

/**
 * Build an IntentEntry from a raw user prompt + optional prior assistant
 * context. Computes the embedding (one round-trip to the embedder) and
 * wraps the contextual form via buildContextualIntent.
 */
async function makeIntentEntry(
  prompt: string,
  priorAssistant: string | null,
  kind: IntentEntry["kind"],
  embeddingModel: string,
  images?: ImageBlock[],
): Promise<IntentEntry> {
  const embeddings = await embedAny(prompt, embeddingModel);
  return {
    // Synthesise stable id up-front. Step 1 of the history-active
    // migration relies on every entry having an id so the active set
    // can reference history by id.
    id: randomUUID(),
    prompt,
    contextual: buildContextualIntent(prompt, priorAssistant),
    embedding: embeddings[0],
    registeredAt: Date.now(),
    kind,
    resolved: false,
    images: images?.length ? images : undefined,
    // Default classifierSource for anything built here (original,
    // confirmation, plus the entries from applyIntentStackUpdate).
    // Step 4 will overwrite to "llm" / "llm-confirmed" when the async
    // classifier returns a verdict.
    classifierSource: "embedding",
  };
}

// trimStack and the legacy single-stack write path were removed in
// the history-active rollout. planActiveSetEviction below subsumes
// the eviction logic with LRU + TTL semantics on the active subset
// of intentHistory rather than the whole stack. The legacy
// "preserve the original entry" carve-out was a poison pill that
// anchored long sessions on turn-1 forever; the active set treats
// every entry as evictable.

/**
 * Embedding-fallback classifier. Decides which `kind` to assign to
 * a fresh prompt without invoking an LLM, using only:
 *   - drift to the top of the live stack
 *   - similarity to non-active historical entries (revisit candidates)
 *   - phrasing patterns
 *   - turn state (open/draining/closed)
 *
 * Returns a verdict the caller applies via SessionStore methods.
 *
 * This is the synchronous fast path. Step 4 will spawn an async LLM
 * classifier in parallel; if the LLM disagrees with this verdict at
 * high confidence, it overrides on the next /evaluate. For now —
 * embedding is the source of truth.
 *
 * Inputs:
 *   prompt              — raw user prompt
 *   promptEmbedding     — pre-computed (caller already needs it for drift)
 *   active              — currently-active intents (from getActiveIntents)
 *   history             — full session history (active + resolved entries)
 *   driftToStackTop     — drift to last live entry, computed once by caller
 *   turnState           — open/draining/closed
 */
export interface EmbeddingClassifierVerdict {
  kind: IntentEntry["kind"];
  /** For "revisit" / "replacement" — id of the entry being acted on. */
  referencedEntryId?: string;
  /** What signal drove the decision; used for telemetry. */
  reason: string;
}

export function classifyIntentByEmbedding(
  prompt: string,
  promptEmbedding: number[],
  active: IntentEntry[],
  history: IntentEntry[],
  driftToStackTop: number | null,
  turnState: TurnState,
): EmbeddingClassifierVerdict {
  // Empty session — first prompt of the session, always original.
  if (active.length === 0 && history.length === 0) {
    return { kind: "original", reason: "empty session" };
  }

  // Turn-state preamble. These two states bind regardless of
  // similarity: the LLM is mid-generation (queued) or hasn't drawn a
  // turn boundary yet (open-followup). The user's prompt is going to
  // be combined with what's already in flight, not treated as a fresh
  // intent. Same as legacy.
  if (turnState === "draining") {
    return { kind: "queued", reason: "turn state draining" };
  }
  if (turnState === "open") {
    return { kind: "open-followup", reason: "turn state open" };
  }

  // Closed turn state — we get to make a real decision based on drift.

  // Revisit: phrasing pattern + a non-active historical entry strongly
  // resembles this prompt. Check before topic-switch — phrasing like
  // "go back to X" with high drift to current actives looks like a
  // topic switch but is actually a revival.
  if (matchesAny(prompt, REVISIT_PHRASING_PATTERNS)) {
    const activeIds = new Set(active.map((e) => e.id).filter(Boolean));
    let bestRevisit: { entry: IntentEntry; sim: number } | null = null;
    for (const e of history) {
      if (!e.id || activeIds.has(e.id)) continue; // not in active set
      if (!e.embedding || e.embedding.length === 0) continue;
      const sim = cosineSimilarity(e.embedding, promptEmbedding);
      if (sim >= REVISIT_SIMILARITY_MIN && (!bestRevisit || sim > bestRevisit.sim)) {
        bestRevisit = { entry: e, sim };
      }
    }
    if (bestRevisit) {
      return {
        kind: "revisit",
        referencedEntryId: bestRevisit.entry.id!,
        reason: `revisit phrasing + similarity ${bestRevisit.sim.toFixed(3)} >= ${REVISIT_SIMILARITY_MIN}`,
      };
    }
    // Phrasing matched but no historical anchor strong enough. Fall
    // through; the LLM (step 4) might still detect a revisit we missed.
  }

  // No drift signal at all — defaults to continuation. Same as legacy.
  if (driftToStackTop === null) {
    return { kind: "continuation", reason: "no drift signal — default continuation" };
  }

  // Short-prompt guard. Single-word / very short replies that fell
  // through the confirmation regex still have unreliable embeddings —
  // "done", "next", "okay then", etc. have near-zero semantic content
  // and cluster meaninglessly in embedding space, so the drift signal
  // is noise. If such a prompt looks like a new-task by drift alone,
  // demote it to continuation. The judge's goal anchor stays correct,
  // and the user only loses a topic-switch they almost certainly
  // didn't mean. Threshold picked at 12 chars trimmed — covers "done",
  // "finished", "looks good", "next step" while still letting
  // genuinely terse new tasks through ("write tests", "deploy now").
  const trimmed = prompt.trim();
  if (trimmed.length < 12 && driftToStackTop > NEW_TASK_DRIFT_MIN) {
    return {
      kind: "continuation",
      reason: `short-prompt guard (len=${trimmed.length}); embedding new-task signal unreliable`,
    };
  }

  // Topic switch: high drift, no replacement-phrasing override below.
  // The replacement check fires before this so "actually do Y instead"
  // (mid-to-high drift, replaces the active goal) doesn't mis-fire as
  // a topic switch that wipes the WHOLE stack.
  if (driftToStackTop > NEW_TASK_DRIFT_MIN) {
    return { kind: "new-task", reason: `drift ${driftToStackTop.toFixed(3)} > ${NEW_TASK_DRIFT_MIN}` };
  }

  // Replacement: phrasing match + the prompt is in the mid-band of
  // drift relative to the top active. We're not so far off that it's
  // a new task, not so close that it's a refinement — the user is
  // pivoting one specific goal. The replaced entry is the top of the
  // active stack (the freshest goal — what they were just doing).
  if (matchesAny(prompt, REPLACEMENT_PHRASING_PATTERNS) && active.length > 0) {
    const target = active[active.length - 1]; // most-recently registered active
    if (target.id) {
      return {
        kind: "replacement",
        referencedEntryId: target.id,
        reason: `replacement phrasing + drift ${driftToStackTop.toFixed(3)}`,
      };
    }
  }

  // Sub-task: phrasing match in the mid-band of drift. Parent (top of
  // active) stays live; the new entry is appended as a child.
  // Distinct from continuation in two ways:
  //   1. The judge sees both parent and child as live goals.
  //   2. When the child is later marked resolved (via Stop), the
  //      parent remains active — a continuation pop wouldn't preserve
  //      that hierarchy.
  if (
    matchesAny(prompt, SUB_TASK_PHRASING_PATTERNS) &&
    driftToStackTop <= SUB_TASK_DRIFT_MAX &&
    active.length > 0
  ) {
    const parent = active[active.length - 1];
    return {
      kind: "sub-task",
      referencedEntryId: parent.id,
      reason: `sub-task phrasing + drift ${driftToStackTop.toFixed(3)} <= ${SUB_TASK_DRIFT_MAX}`,
    };
  }

  // Continuation: low drift, no special phrasing.
  if (driftToStackTop < CONTINUATION_DRIFT_MAX) {
    return { kind: "continuation", reason: `drift ${driftToStackTop.toFixed(3)} < ${CONTINUATION_DRIFT_MAX}` };
  }

  // Ambiguous middle — default to continuation, conservative. Step 4's
  // LLM classifier is most useful here, where embeddings aren't
  // distinguishing.
  return {
    kind: "continuation",
    reason: `ambiguous drift ${driftToStackTop.toFixed(3)} — default continuation`,
  };
}

/**
 * Downgrade a history-active classifier verdict to a legacy-compatible
 * kind. Used when INTENT_HISTORY_MODE=legacy (the default) so the
 * new sub-task / replacement / revisit kinds don't leak into the
 * write path or the judge prompt for sessions on legacy. The mapping
 * is conservative: each new kind collapses to whichever legacy kind
 * produces the closest active-set behaviour.
 */
function downgradeKindForLegacy(
  v: EmbeddingClassifierVerdict,
): EmbeddingClassifierVerdict {
  if (v.kind === "sub-task" || v.kind === "replacement") {
    return { kind: "continuation", reason: `[legacy mode] downgraded from ${v.kind}` };
  }
  if (v.kind === "revisit") {
    return { kind: "new-task", reason: `[legacy mode] downgraded from revisit` };
  }
  return v;
}

/**
 * History-active equivalent of trimStack. Operates on the resolved
 * active set (entries already materialised from history+activeIntentIds)
 * and decides which to keep:
 *
 *   1. Drop resolved entries whose registeredAt is older than
 *      RESOLVED_INTENT_TTL_MS. They stay in history (the SessionStore
 *      enforces history-side TTL separately at 30d) but are no longer
 *      live for the judge.
 *   2. Cap the live set at MAX_ACTIVE_INTENTS via LRU on lastActiveAt
 *      (fallback registeredAt). Newest stay; oldest get evicted to
 *      resolved.
 *
 * Returns an evictionPlan: which ids should be marked resolved
 * (removed from active, kept in history). The caller applies it via
 * the SessionStore's markIntentResolved.
 */
function planActiveSetEviction(
  active: IntentEntry[],
  lastActiveMap?: Record<string, number>,
): {
  keep: IntentEntry[];
  resolveIds: string[];
} {
  const now = Date.now();
  const resolveIds: string[] = [];
  const fresh = active.filter((e) => {
    if (!e.resolved) return true;
    if (now - e.registeredAt < RESOLVED_INTENT_TTL_MS) return true;
    if (e.id) resolveIds.push(e.id);
    return false;
  });
  if (fresh.length <= MAX_ACTIVE_INTENTS) {
    return { keep: fresh, resolveIds };
  }
  // LRU: sort oldest-touch-first, evict from the front. The
  // lastActiveMap (when supplied) is the SessionStore's authoritative
  // intentLastActive — falling back to the per-entry lastActiveAt /
  // registeredAt for entries the map doesn't know about (legacy
  // entries pre-Step-2 migration, or freshly-built entries that the
  // hot path hasn't touched yet).
  const sorted = [...fresh].sort((a, b) => {
    const ta =
      (a.id ? lastActiveMap?.[a.id] : undefined) ??
      a.lastActiveAt ??
      a.registeredAt;
    const tb =
      (b.id ? lastActiveMap?.[b.id] : undefined) ??
      b.lastActiveAt ??
      b.registeredAt;
    return ta - tb;
  });
  const evictCount = sorted.length - MAX_ACTIVE_INTENTS;
  const evicted = sorted.slice(0, evictCount);
  const keepIds = new Set(sorted.slice(evictCount).map((e) => e.id));
  for (const e of evicted) {
    if (e.id) resolveIds.push(e.id);
  }
  // Restore registration order for the kept entries.
  const keep = active.filter((e) => e.id && keepIds.has(e.id));
  return { keep, resolveIds };
}

export interface IntentStackUpdateResult {
  /** What classification we applied. */
  kind: IntentEntry["kind"];
  /** Turn state at the moment of the new prompt. */
  turnState: TurnState;
  /** Final stack after the update. */
  stack: IntentEntry[];
  /**
   * Cosine distance to the closest stack entry before the new prompt
   * was added — null when the stack was empty (very first prompt).
   */
  driftToStackTop: number | null;
  /**
   * ID of the freshly-registered entry. Step 4 uses this to apply
   * an async-LLM-classifier override: if the LLM disagrees with the
   * embedding fallback at high confidence, the override needs to
   * mutate this specific entry (overwrite its kind, possibly
   * mark/activate other entries) before the next /evaluate.
   */
  newEntryId?: string;
}

/**
 * Apply the interactive/learn stack update for a new UserPromptSubmit.
 *
 * @param store              the SessionStore (cached or in-memory)
 * @param sessionId
 * @param prompt             raw user prompt (after fence-tag scrub)
 * @param priorAssistant     prior assistant text from transcript (may be null)
 * @param isConfirmation     classification from the /intent regex
 * @param prevTimings        markers BEFORE we noted this UserPromptSubmit
 * @param embeddingModel     CONFIG.embeddingModel
 * @param images             attached images, if any
 * @param historyActiveMode  when true (INTENT_HISTORY_MODE=history-active),
 *                            the embedding classifier may produce
 *                            sub-task / replacement / revisit kinds.
 *                            When false (default legacy), only the
 *                            original / continuation / new-task /
 *                            queued / open-followup / confirmation
 *                            kinds are emitted — preserves existing
 *                            production behaviour exactly.
 */
export async function applyIntentStackUpdate(
  store: SessionStore,
  sessionId: string,
  prompt: string,
  priorAssistant: string | null,
  isConfirmation: boolean,
  prevTimings: {
    prevUserPromptAt: number;
    prevPreToolUseAt: number;
    prevStopAt: number;
  },
  embeddingModel: string,
  images?: ImageBlock[],
  historyActiveMode: boolean = false,
): Promise<IntentStackUpdateResult> {
  const turnState = deriveTurnState(prevTimings);
  const existing = await store.getActiveIntents(sessionId);

  // First prompt of the session — always "original".
  if (existing.length === 0) {
    const entry = await makeIntentEntry(
      prompt,
      priorAssistant,
      "original",
      embeddingModel,
      images,
    );
    const stack = [entry];
    // setActiveIntents writes both legacy activeIntents and the new
    // history+ids fields. Step 7 cleanup will switch this to a pure
    // appendToHistory + activateIntent call once setActiveIntents is
    // removed.
    await store.setActiveIntents(sessionId, stack);
    return { kind: "original", turnState, stack, driftToStackTop: null, newEntryId: entry.id };
  }

  // Promote assistant-option-picks to confirmation. The regex above
  // (isConfirmation from handlers/intent.ts) catches "yes" / "ok" /
  // "done" style replies; this catches "2", "the second one",
  // "option B please", "let's do tests" when the assistant just
  // offered a numbered or bulleted menu. Lets short menu-picks land
  // on the confirmation path (adopt assistant proposal as the new
  // top) instead of trying to embed-classify a meaningless single
  // token. The flag flows through to the same makeIntentEntry call
  // below so feed / dashboard see kind="confirmation".
  const isOptionPick = !isConfirmation && detectAssistantOptionPick(prompt, priorAssistant);
  const effectiveConfirmation = isConfirmation || isOptionPick;

  // Confirmation: adopt the prior assistant proposal as the new top.
  // Falls through to "queued" if there is no prior assistant context —
  // a bare "yes" with no proposal can't carry a meaningful goal so we
  // treat it as a queued/open follow-up against the existing stack.
  if (effectiveConfirmation && priorAssistant) {
    const entry = await makeIntentEntry(
      prompt,
      priorAssistant,
      "confirmation",
      embeddingModel,
      images,
    );
    const lastActiveMap = await store.getIntentLastActive(sessionId);
    const planned = planActiveSetEviction([...existing, entry], lastActiveMap);
    if (planned.resolveIds.length > 0) {
      await store.markIntentResolved(sessionId, planned.resolveIds);
    }
    await store.setActiveIntents(sessionId, planned.keep);
    return {
      kind: "confirmation",
      turnState,
      stack: planned.keep,
      driftToStackTop: 0,
      newEntryId: entry.id,
    };
  }

  // Compute drift to the most recent live stack entry — the variable
  // name has always been driftToStackTop, but the implementation took
  // max-over-entire-stack similarity, which monotonically converges to
  // 1 (drift -> 0) as the stack grows. In long sessions every new
  // CS-development prompt was similar to *something* in a 5+ entry
  // stack, so new-task could never fire. Switch to genuine
  // top-of-live-stack: only compare against the latest non-resolved
  // entry. If nothing is live, fall back to the most recent existing
  // entry so we keep some signal.
  const promptEmbedding = (await embedAny(prompt, embeddingModel))[0];
  const liveEntries = existing.filter((e) => !e.resolved);
  const compareSet = liveEntries.length > 0 ? liveEntries : existing;
  // Top of stack = most recently registered entry. compareSet is in
  // registration order, so the last element is the freshest.
  let topSim: number | null = null;
  for (let i = compareSet.length - 1; i >= 0; i--) {
    const e = compareSet[i];
    if (e.embedding && e.embedding.length > 0) {
      topSim = cosineSimilarity(e.embedding, promptEmbedding);
      break;
    }
  }
  const driftToStackTop = topSim === null ? null : 1 - topSim;

  // Embedding-fallback classifier — synchronous decision based on
  // drift, history, and phrasing. Step 4 will spawn an async LLM
  // classifier in parallel; if it disagrees at high confidence the
  // active set is updated on the next /evaluate.
  const history = await store.getIntentHistory(sessionId);
  const rawVerdict = classifyIntentByEmbedding(
    prompt,
    promptEmbedding,
    existing,
    history,
    driftToStackTop,
    turnState,
  );
  // Step-6 rollout gate. In legacy mode (default) downgrade the new
  // kinds to their legacy equivalents so observable behaviour matches
  // the pre-history-active stack:
  //   - sub-task    -> continuation (parent stays on stack via the
  //                                   existing continuation path)
  //   - revisit     -> new-task     (a high-drift prompt back to a
  //                                   resolved goal looked like a
  //                                   topic switch in the legacy model)
  //   - replacement -> continuation (legacy didn't distinguish the
  //                                   replaced active goal — same
  //                                   net effect: append + LRU
  //                                   eventually evicts)
  const verdict = !historyActiveMode
    ? downgradeKindForLegacy(rawVerdict)
    : rawVerdict;
  const kind = verdict.kind;

  // Per-kind state transitions on the active set.
  let baseStack = [...existing];

  if (kind === "new-task") {
    // True topic switch — wipe resolved entries (including the
    // original) so the judge isn't anchored on a defunct goal.
    const toResolve = baseStack.filter((e) => e.resolved && e.id).map((e) => e.id!);
    if (toResolve.length > 0) {
      await store.markIntentResolved(sessionId, toResolve);
    }
    baseStack = baseStack.filter((e) => !e.resolved);
  } else if (kind === "replacement" && verdict.referencedEntryId) {
    // Mark only the replaced entry resolved (kept in history). Other
    // active goals stay live — the user is replacing one specific
    // goal, not switching topics entirely.
    await store.markIntentResolved(sessionId, [verdict.referencedEntryId]);
    baseStack = baseStack.filter((e) => e.id !== verdict.referencedEntryId);
  } else if (kind === "revisit" && verdict.referencedEntryId) {
    // Bring the historical entry back into the active set. The
    // SessionStore's activateIntent handles LRU eviction if the
    // active set is already at capacity. Other active entries stay
    // live in case the user is multi-tasking, but the new prompt
    // anchors on the revived goal.
    await store.activateIntent(sessionId, verdict.referencedEntryId);
    // Re-read the active set so the freshly-revived entry is included.
    baseStack = await store.getActiveIntents(sessionId);
  }
  // continuation, sub-task, queued, open-followup: no eviction, just
  // append the new entry. Sub-task is identical to continuation from
  // an active-set perspective; the difference is the kind tag, which
  // step 5 renders to the judge so it can distinguish parent/child.

  const entry: IntentEntry = {
    // Synthesise the id up-front so planActiveSetEviction can refer
    // to this entry by id (it's the freshest entry, never a candidate
    // for eviction in a fresh-stack pass, but we want symmetry with
    // the rest of the entries — every active intent should have an
    // id once it leaves this function).
    id: randomUUID(),
    prompt,
    contextual: buildContextualIntent(prompt, priorAssistant),
    embedding: promptEmbedding,
    registeredAt: Date.now(),
    kind,
    resolved: false,
    images: images?.length ? images : undefined,
    // classifierSource is "embedding" until step 4 wires the async
    // LLM classifier; entries from the embedding-only path are tagged
    // explicitly so the dashboard + telemetry can count overrides.
    classifierSource: "embedding",
    // referencedEntryId carried through for replacement/revisit/
    // sub-task entries so the dashboard and step 5's judge prompt
    // can render parent/child relationships.
    referencedEntryId: verdict.referencedEntryId,
  };
  // LRU-evict to MAX_ACTIVE_INTENTS, marking evicted ids resolved (kept
  // in history). Replaces the old trimStack call.
  const lastActiveMap = await store.getIntentLastActive(sessionId);
  const planned = planActiveSetEviction([...baseStack, entry], lastActiveMap);
  if (planned.resolveIds.length > 0) {
    await store.markIntentResolved(sessionId, planned.resolveIds);
  }
  await store.setActiveIntents(sessionId, planned.keep);

  console.log(
    `  [SESSION ${sessionId.substring(0, 8)}] [INTENT-CLASSIFY] kind=${kind}` +
    (verdict.referencedEntryId ? ` ref=${verdict.referencedEntryId.substring(0, 8)}` : "") +
    ` drift=${driftToStackTop?.toFixed(3) ?? "n/a"} (${verdict.reason})`,
  );

  return { kind, turnState, stack: planned.keep, driftToStackTop, newEntryId: entry.id };
}

/**
 * Apply an async-LLM-classifier override against a session whose
 * embedding-fallback verdict is already in place. Called after
 * /intent has returned its response — the LLM call (1.5–2.5s) runs
 * in the background and this function takes the verdict, decides
 * whether to override the embedding-fallback decision, and applies
 * the change via SessionStore methods.
 *
 * Override policy:
 *   - LLM verdict same kind as embedding fallback → no-op, just tag
 *     the entry's classifierSource as "llm-confirmed" for telemetry.
 *   - LLM verdict different AND confidence is "high" → apply override.
 *   - LLM verdict different AND confidence is "medium" or "low" →
 *     keep embedding fallback. Low-confidence flips would just churn
 *     state without clear benefit; logged for telemetry.
 *
 * Per the design doc, the override mutates the active set (mark
 * entries resolved, activate historical entries) but DOES NOT
 * retroactively change the kind of an entry that's already been
 * registered — the new entry's kind is updated in place, but
 * historical entries keep whatever kind they had at registration.
 */
export async function applyClassifierOverride(
  store: SessionStore,
  sessionId: string,
  newEntryId: string,
  llmVerdict: import("./intent-classifier.js").ClassifierVerdict,
): Promise<{ overridden: boolean; reason: string; embeddingKind?: IntentEntry["kind"] }> {
  // Read the embedding-fallback verdict directly from history rather
  // than threading it through the call signature. The new entry was
  // registered with classifierSource="embedding" by the synchronous
  // path; its kind is the embedding's verdict.
  const history = await store.getIntentHistory(sessionId);
  const newEntry = history.find((e) => e.id === newEntryId);
  if (!newEntry) {
    return {
      overridden: false,
      reason: `llm verdict ${llmVerdict.kind} arrived but entry ${newEntryId} no longer in history`,
    };
  }
  const embeddingKind = newEntry.kind;
  // Same kind — confirm and tag for telemetry.
  if (llmVerdict.kind === embeddingKind) {
    await tagClassifierConfirmed(store, sessionId, newEntryId);
    return { overridden: false, reason: "llm agreed with embedding", embeddingKind };
  }
  // Different kind but low confidence — defer to embedding.
  if (llmVerdict.confidence !== "high") {
    return {
      overridden: false,
      reason: `llm disagreed (${embeddingKind} → ${llmVerdict.kind}) but confidence ${llmVerdict.confidence} — keeping embedding`,
      embeddingKind,
    };
  }

  // Roll back the state transitions the embedding kind performed.
  // We need to undo before applying so the LLM's decision lands
  // against a clean state, not a hybrid where both classifiers'
  // mutations compound.
  const embeddingRefId = newEntry.referencedEntryId;
  if (embeddingKind === "revisit" && embeddingRefId) {
    // Embedding activated a historical entry — mark it resolved
    // again. The LLM may re-activate a different one below if its
    // verdict says so.
    await store.markIntentResolved(sessionId, [embeddingRefId]);
  } else if (embeddingKind === "replacement" && embeddingRefId) {
    // Embedding marked the referenced entry resolved — bring it
    // back into the active set.
    await store.activateIntent(sessionId, embeddingRefId);
  } else if (embeddingKind === "new-task") {
    // Embedding marked every other active entry resolved. We can't
    // distinguish those that were resolved by this pivot from those
    // that were already resolved before, so we leave them resolved
    // — the LLM verdict is more likely a continuation/sub-task that
    // shouldn't have wiped them, but their content is preserved in
    // intentHistory and a follow-up revisit can revive any that
    // matter. Documenting this asymmetry rather than silently
    // hiding it.
  }
  // continuation / sub-task / open-followup / queued / confirmation:
  // no state transitions to roll back beyond appending the new entry,
  // and the new entry stays appended regardless of the override.

  // Apply the LLM's decision against the rolled-back state.
  if (llmVerdict.kind === "revisit" && llmVerdict.referencedEntryId) {
    await store.activateIntent(sessionId, llmVerdict.referencedEntryId);
  } else if (llmVerdict.kind === "replacement" && llmVerdict.referencedEntryId) {
    await store.markIntentResolved(sessionId, [llmVerdict.referencedEntryId]);
  } else if (llmVerdict.kind === "new-task") {
    // Mark all other actives resolved.
    const active = await store.getActiveIntents(sessionId);
    const toResolve = active
      .filter((e) => e.id && e.id !== newEntryId)
      .map((e) => e.id!);
    if (toResolve.length > 0) {
      await store.markIntentResolved(sessionId, toResolve);
    }
  }
  // Update the new entry's kind + classifierSource + referencedEntryId
  // in history. We rebuild the active set view by re-applying
  // setActiveIntents with the updated entry mixed back in.
  const updatedHistory = history.map((e) =>
    e.id === newEntryId
      ? {
          ...e,
          kind: llmVerdict.kind as IntentEntry["kind"],
          classifierSource: "llm" as const,
          referencedEntryId: llmVerdict.referencedEntryId,
        }
      : e,
  );
  // Rebuild active using whatever the store now holds, mixing in the
  // updated entry by id.
  const currentActive = await store.getActiveIntents(sessionId);
  const updatedActive = currentActive.map((e) =>
    e.id === newEntryId
      ? updatedHistory.find((h) => h.id === newEntryId)!
      : e,
  );
  await store.setActiveIntents(sessionId, updatedActive);

  return {
    overridden: true,
    reason: `llm overrode embedding ${embeddingKind} → ${llmVerdict.kind} (high conf)`,
    embeddingKind,
  };
}

/**
 * Tag an existing history entry's classifierSource as "llm-confirmed"
 * — the LLM agreed with the embedding fallback. Doesn't change the
 * active set; this is purely a telemetry marker on the entry.
 *
 * Uses the SessionStore's focused setEntryClassifierSource method so
 * the common-case LLM-agreed path doesn't trigger a full
 * intentHistory rewrite on every /intent.
 */
async function tagClassifierConfirmed(
  store: SessionStore,
  sessionId: string,
  entryId: string,
): Promise<void> {
  await store.setEntryClassifierSource(sessionId, entryId, "llm-confirmed");
}

/**
 * Structured backfill envelope sent by the hook in place of the raw
 * transcript JSONL. Carries only the bits the server actually
 * consumes — user prompts (intent history), tool_use blocks (tool
 * history), file IO, and the (lastUser, priorAssistant) pair the
 * judge anchors on. Anything else in the transcript (system prompts,
 * tool results, attachments, file-history-snapshots, permission-mode
 * markers) is JSONL ballast we don't need on the wire.
 *
 * Hook v1: ~5KB on a 50-prompt session vs ~800KB raw transcript.
 *
 * Server falls back to parsing transcript_content / transcript_path
 * when transcript_summary is absent or version-bumped past the
 * current schema, so an old hook talking to a new server still works.
 */
export interface TranscriptSummary {
  /** Schema version. Bump when fields change in a non-additive way. */
  version: 1;
  /** Every non-synthetic user prompt seen, oldest-first. Each carries
   *  the inline images that were attached to it. */
  userPrompts: { text: string; images: ImageBlock[] }[];
  /** The most recent non-confirmation user prompt — i.e. what the
   *  judge should treat as the active goal. */
  lastUserText: string | null;
  /** Inline images attached to lastUserText, if any. */
  lastUserImages: ImageBlock[];
  /** Most recent assistant text block before lastUserText. The
   *  judge wraps this into the contextual intent so it knows what
   *  the agent had just claimed before the user's prompt. */
  priorAssistantText: string | null;
  /** Tool calls (assistant tool_use blocks) in order. */
  toolCalls: { tool: string; input: Record<string, unknown> }[];
  /** File paths read via the Read tool. */
  filesRead: string[];
  /** Files written / edited by Write/Edit tools. */
  filesWritten: { path: string; content: string; isEdit: boolean }[];
}

/**
 * Apply a parsed backfill payload to the session state. Shared by
 * the JSONL parser (`backfillFromTranscript`) and the structured
 * envelope path (`backfillFromSummary`).
 *
 * Idempotent on `registeredSessions`: callers can invoke this on
 * every UserPromptSubmit and only the first call (per session)
 * actually mutates state — subsequent calls early-return because
 * the session is already in the registered set.
 */
/**
 * A backfilled goal prompt is usable only if it carries real (non-whitespace)
 * text. When the transcript yields no usable last-user turn, registering an
 * empty/undefined goal would (a) historically crash the judge via
 * buildContextualIntent(undefined) → contextual=undefined → fail-soft allow,
 * and (b) even once that is guarded, leave the judge with nothing to evaluate
 * against for the rest of the session. applyBackfill skips registration when
 * this returns false, dropping PreToolUse to policy-only mode.
 */
export function isUsableGoalText(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trim().length > 0;
}

async function applyBackfill(
  sessionId: string,
  parts: {
    userPrompts: { text: string; images: ImageBlock[] }[];
    lastUserText: string | null;
    lastUserImages: ImageBlock[];
    priorAssistantText: string | null;
    toolCalls: { tool: string; input: Record<string, unknown> }[];
    filesRead: string[];
    filesWritten: { path: string; content: string; isEdit: boolean }[];
  },
  source: "transcript" | "summary",
): Promise<void> {
  const { userPrompts, toolCalls, filesRead, filesWritten } = parts;
  if (userPrompts.length === 0) return;

  const lastUser = parts.lastUserText;
  const lastImages = parts.lastUserImages ?? [];
  const priorAssistant = parts.priorAssistantText;

  let goalIdx = userPrompts.length - 1;
  if (lastUser) {
    for (let i = userPrompts.length - 1; i >= 0; i--) {
      if (userPrompts[i].text === lastUser) { goalIdx = i; break; }
    }
  }
  const goalEntry = userPrompts[goalIdx];
  const goalPrompt = lastUser ?? goalEntry.text;
  if (!isUsableGoalText(goalPrompt)) {
    console.log(
      `  [BACKFILL] Session ${sessionId.substring(0, 8)}: no usable goal prompt ` +
      `recovered from ${source} (${userPrompts.length} prompt(s)); skipping intent ` +
      `registration — PreToolUse runs policy-only`
    );
    return;
  }
  const goalImages = lastImages.length ? lastImages : goalEntry.images;
  const contextualGoal = buildContextualIntent(goalPrompt, priorAssistant);

  console.log(
    `  [BACKFILL] Session ${sessionId.substring(0, 8)}: ` +
    `${userPrompts.length} user prompts, ${toolCalls.length} tools, ` +
    `${filesRead.length} reads, ${filesWritten.length} writes` +
    `${goalImages.length ? `, ${goalImages.length} image(s)` : ""}` +
    ` from ${source}`
  );

  for (let i = 0; i < goalIdx; i++) {
    const p = userPrompts[i];
    await tracker.registerIntent(sessionId, p.text, true, p.images);
  }
  await tracker.registerIntent(sessionId, goalPrompt, false, goalImages);
  await interceptor.registerGoal(sessionId, contextualGoal, goalImages);
  registeredSessions.add(sessionId);

  for (const path of filesRead) {
    await tracker.recordFileRead(sessionId, path, "(backfilled)");
  }
  for (const file of filesWritten) {
    await tracker.recordFileWrite(sessionId, file.path, file.content, file.isEdit);
  }

  for (const tc of toolCalls) {
    await tracker.recordToolCall(sessionId, tc.tool, tc.input, "allow", null);
  }

  console.log(
    `  [BACKFILL] Latest intent: "${goalPrompt.substring(0, 60)}..." ` +
    `(prior assistant context: ${priorAssistant ? "yes" : "no"})`
  );
}

/**
 * Fast-path backfill from the hook's structured envelope. Skips
 * JSONL parsing entirely; trusts the envelope's shape (the hook
 * already filtered synthetic entries and identified the goal turn).
 *
 * Returns true if the envelope was applied, false if it was missing
 * or malformed (callers fall back to backfillFromTranscript).
 */
export async function backfillFromSummary(
  sessionId: string,
  summary: unknown,
): Promise<boolean> {
  if (!summary || typeof summary !== "object") return false;
  const s = summary as Partial<TranscriptSummary>;
  if (s.version !== 1) return false;
  if (!Array.isArray(s.userPrompts)) return false;

  // Defensive coercion: the hook composes the envelope in jq, but
  // an old/buggy hook could ship a payload with stray nulls. Coerce
  // to the shape applyBackfill expects, dropping anything malformed.
  const userPrompts = s.userPrompts
    .filter((p): p is { text: string; images: ImageBlock[] } =>
      Boolean(p) && typeof (p as any).text === "string"
    )
    .map((p) => ({ text: p.text, images: Array.isArray(p.images) ? p.images : [] }));

  if (userPrompts.length === 0) return false;

  const toolCalls = (Array.isArray(s.toolCalls) ? s.toolCalls : [])
    .filter((t): t is { tool: string; input: Record<string, unknown> } =>
      Boolean(t) && typeof (t as any).tool === "string"
    )
    .map((t) => ({ tool: t.tool, input: t.input ?? {} }));

  const filesRead = (Array.isArray(s.filesRead) ? s.filesRead : [])
    .filter((p): p is string => typeof p === "string");

  const filesWritten = (Array.isArray(s.filesWritten) ? s.filesWritten : [])
    .filter((f): f is { path: string; content: string; isEdit: boolean } =>
      Boolean(f) && typeof (f as any).path === "string"
    )
    .map((f) => ({
      path: f.path,
      content: typeof f.content === "string" ? f.content : "",
      isEdit: Boolean(f.isEdit),
    }));

  try {
    await applyBackfill(
      sessionId,
      {
        userPrompts,
        lastUserText: typeof s.lastUserText === "string" ? s.lastUserText : null,
        lastUserImages: Array.isArray(s.lastUserImages) ? s.lastUserImages : [],
        priorAssistantText: typeof s.priorAssistantText === "string" ? s.priorAssistantText : null,
        toolCalls,
        filesRead,
        filesWritten,
      },
      "summary",
    );
    return true;
  } catch (err) {
    console.error(
      `  [BACKFILL] Summary backfill failed for ${sessionId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

export async function backfillFromTranscript(
  sessionId: string,
  transcriptPathOrContent: string,
  isContent = false
): Promise<void> {
  let raw: string;
  if (isContent) {
    raw = transcriptPathOrContent;
  } else {
    const safe = safeServerReadablePath(transcriptPathOrContent);
    if (!safe) return;
    try {
      raw = readFileSync(safe, "utf8");
    } catch {
      return;
    }
  }

  try {
    const lines = raw.trim().split("\n").filter(Boolean);

    const userPrompts: { text: string; images: ImageBlock[] }[] = [];
    const toolCalls: { tool: string; input: Record<string, unknown> }[] = [];
    const filesRead: string[] = [];
    const filesWritten: { path: string; content: string; isEdit: boolean }[] = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);

        if (msg.type === "user") {
          const { text, images: imgs } = extractTextAndImages(msg.message?.content);
          const trimmed = text.trim();
          if (!isSyntheticUserEntry(msg, trimmed) && (trimmed || imgs.length)) {
            userPrompts.push({ text: trimmed, images: imgs });
          }
        }

        if (msg.type === "assistant") {
          const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const block of blocks) {
            if (block.type === "tool_use") {
              const tool = block.name;
              const input = block.input ?? {};
              toolCalls.push({ tool, input });

              if (tool === "Read") {
                filesRead.push(String(input.file_path ?? ""));
              }
              if (tool === "Write") {
                filesWritten.push({
                  path: String(input.file_path ?? ""),
                  content: String(input.content ?? ""),
                  isEdit: false,
                });
              }
              if (tool === "Edit") {
                filesWritten.push({
                  path: String(input.file_path ?? ""),
                  content: String(input.new_string ?? ""),
                  isEdit: true,
                });
              }
            }
          }
        }
      } catch {}
    }

    const { lastUser, priorAssistant, images: lastImages } =
      extractLastUserAndPriorAssistant(raw, true);

    await applyBackfill(
      sessionId,
      {
        userPrompts,
        lastUserText: lastUser,
        lastUserImages: lastImages,
        priorAssistantText: priorAssistant,
        toolCalls,
        filesRead,
        filesWritten,
      },
      "transcript",
    );
  } catch (err) {
    console.error(
      `  [BACKFILL] Failed for session ${sessionId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

