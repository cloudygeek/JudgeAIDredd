/**
 * Transcript backfill helpers.
 *
 * Parses Claude Code's per-session JSONL transcript files to extract
 * the last user prompt + the prior assistant turn — used when Dredd's
 * `/evaluate` fires before `/intent` (server restart, fresh container)
 * and we have to reconstruct intent from the transcript on disk.
 *
 * Also hosts the fence-tag scrubbing + instruction-injection patterns
 * that defend the judge prompt from delimiter and override attacks,
 * plus `buildContextualIntent` which assembles the
 * `<prior_assistant_response>…<user_prompt>` string fed to the judge.
 *
 * Extracted from `server-core.ts`. Re-exported there for backwards
 * compatibility.
 */

import { readFileSync } from "node:fs";
import type { ImageBlock } from "./session-types.js";
import { safeServerReadablePath } from "./server-core.js";

/**
 * Single source of truth for "is this short user reply a confirmation
 * of the previous turn, not a new goal?". Used by both transcript
 * backfill and the live /intent classifier (re-exported through
 * server-core to handlers/intent.ts) so they stay in sync — divergence
 * here was the original cause of "option 2" being treated as a new
 * goal and tripping drift-deny on the next tool call.
 *
 * Added in 2026-05-20: "done", "finished", "great", "perfect", "nice",
 * "good". A user typing one of these after a tool call is acknowledging
 * the previous turn, not stating a new task. Embedding-only
 * classification of single-word affirmations is unreliable (vectors
 * cluster meaninglessly), which led to mis-classification as new-task
 * and a stale goal anchor on the next /evaluate.
 */
// Anchored end-of-string (after optional punctuation/emoji/whitespace)
// so "done with the spec, now build the api" does NOT match as a
// confirmation — only standalone affirmations do. Earlier shape used
// `\b` which had the same bug: matched any prompt that BEGAN with one
// of these words. The strict-anchor form is the one the live /intent
// classifier was using; transcript-backfill is now also strict, and
// both share this single source.
export const CONFIRMATION_REGEX =
  /^\s*(yes|yeah|yep|ok|okay|sure|do it|go ahead|go|proceed|continue|y|k|confirm|approved?|lgtm|ship it|sounds good|that's right|correct|exactly|please|thanks|thank you|option\s+\w+|done|finished|great|perfect|nice|good|👍)\s*[.!?👍]*\s*$/i;

export function isConfirmationPrompt(text: string): boolean {
  return CONFIRMATION_REGEX.test(text) && text.trim().length < 80;
}

export function extractImagesFromContentBlocks(blocks: any[]): ImageBlock[] {
  const images: ImageBlock[] = [];
  for (const b of blocks) {
    if (b.type === "image" && b.source?.type === "base64" && b.source?.data) {
      images.push({
        data: b.source.data,
        mediaType: b.source.media_type ?? "image/png",
      });
    }
  }
  return images;
}

export function extractTextAndImages(content: unknown): { text: string; images: ImageBlock[] } {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
    return { text, images: extractImagesFromContentBlocks(content) };
  }
  return { text: "", images: [] };
}

export function isSyntheticUserEntry(msg: any, text: string): boolean {
  if (msg?.isMeta === true) return true;
  const t = text.trim();
  if (!t) return false;
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<command-args>")
  );
}

export function extractLastUserAndPriorAssistant(
  transcriptPathOrContent: string,
  isContent = false
): { lastUser: string | null; priorAssistant: string | null; images: ImageBlock[] } {
  let raw: string;
  if (isContent) {
    raw = transcriptPathOrContent;
  } else {
    const safe = safeServerReadablePath(transcriptPathOrContent);
    if (!safe) {
      return { lastUser: null, priorAssistant: null, images: [] };
    }
    try {
      raw = readFileSync(safe, "utf8");
    } catch {
      return { lastUser: null, priorAssistant: null, images: [] };
    }
  }
  try {
    const lines = raw.trim().split("\n").filter(Boolean);
    const userTurns: { user: string; prior: string | null; images: ImageBlock[] }[] = [];
    let pendingAssistant: string | null = null;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant") {
          const { text } = extractTextAndImages(msg.message?.content);
          const trimmed = text.trim();
          if (trimmed) pendingAssistant = trimmed;
        } else if (msg.type === "user") {
          const { text, images: imgs } = extractTextAndImages(msg.message?.content);
          const trimmed = text.trim();
          if (isSyntheticUserEntry(msg, trimmed)) continue;
          if (trimmed || imgs.length) {
            userTurns.push({ user: trimmed, prior: pendingAssistant, images: imgs });
          }
        }
      } catch {}
    }

    if (userTurns.length === 0) return { lastUser: null, priorAssistant: null, images: [] };

    for (let i = userTurns.length - 1; i >= 0; i--) {
      if (!isConfirmationPrompt(userTurns[i].user)) {
        return { lastUser: userTurns[i].user, priorAssistant: userTurns[i].prior, images: userTurns[i].images };
      }
    }
    const last = userTurns[userTurns.length - 1];
    return { lastUser: last.user, priorAssistant: last.prior, images: last.images };
  } catch {
    return { lastUser: null, priorAssistant: null, images: [] };
  }
}

/**
 * Tag names we use to fence trusted vs untrusted content in the judge
 * prompt. If any of these appear in caller-supplied text (assistant or
 * user) they are stripped before reaching the prompt — otherwise an
 * attacker could close the tag, inject directives in what the model
 * sees as the system context, and reopen.
 *
 * Keep this list in sync with the tags actually used in
 *   - this file's buildContextualIntent (<prior_assistant_response>, <user_prompt>)
 *   - intent-judge.ts evaluate() (<user_intent>, <actions>, <action>)
 */
const FENCE_TAG_NAMES = [
  "user_intent",
  "user_prompt",
  "prior_assistant_response",
  "actions",
  "action",
] as const;

/**
 * Match any open or close tag matching one of the fence tag names,
 * tolerating whitespace and case. Replaced with [REDACTED:fence-tag]
 * to neutralise delimiter-injection attempts.
 */
const FENCE_TAG_RE = new RegExp(
  `<\\s*/?\\s*(?:${FENCE_TAG_NAMES.join("|")})\\s*>`,
  "gi",
);

/**
 * Patterns that, when found in untrusted assistant text, are nuked before
 * reaching the judge prompt. Defence-in-depth alongside the system-prompt
 * "treat as data" directive — even if the model misinterprets the
 * directive, the obvious injection attempts never reach it.
 *
 * Each pattern matches a phrase commonly used in prompt-injection PoCs;
 * the redaction marker preserves token count roughly so the surrounding
 * context still reads naturally.
 *
 * NOT applied to user prompts (those are trusted input). Only used by
 * sanitiseAssistantContent below. Fence-tag scrubbing IS applied to user
 * prompts separately by sanitiseFenceTags.
 */
const INJECTION_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?|system|directives?)/gi, reason: "ignore-previous" },
  { re: /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?|system|directives?)/gi, reason: "disregard-previous" },
  { re: /(you\s+are\s+now|from\s+now\s+on,?\s+you\s+(are|will|must))\b/gi, reason: "role-override" },
  { re: /<\s*\/?\s*(system|admin|root|sudo)\s*>/gi, reason: "fake-tag" },
  { re: /\[\s*(system|admin|root|sudo)\s*\]/gi, reason: "fake-bracket" },
  { re: /regardless\s+of\s+(any|all|other|previous|prior)\s+(instructions?|rules?|directives?|context)/gi, reason: "regardless-of" },
  { re: /(respond|reply|answer|return|output)[\s:]+(only|exclusively|with)?\s*(the\s+)?(json|word|verdict|consistent|drifting|hijacked)/gi, reason: "force-output" },
  { re: /(classify|judge|treat|mark|consider)\s+(all|every|any|the\s+following)\s+(subsequent|next|following|further)\s+(tool|action|call|request)/gi, reason: "classify-subsequent" },
  { re: /important:\s*(regardless|ignore|disregard|always|never)/gi, reason: "important-override" },
  { re: /(your\s+)?(only\s+)?(real\s+)?(true\s+)?(actual\s+)?(real\s+)?(task|job|goal|objective)\s+is\s+(to\s+)?(now\s+)?(actually\s+)?(really\s+)?(?=\w)/gi, reason: "task-override" },
];

/**
 * Strip any fence-tag (open or close) we use to delimit untrusted content
 * in the judge prompt. Applied to BOTH user prompts and assistant text
 * because the attacker doesn't need to be the LLM to inject delimiters —
 * a user could paste text containing `</user_intent>` from a previous
 * conversation log too.
 *
 * Exported so server-hook can scrub the user prompt before it's wrapped.
 */
export function sanitiseFenceTags(text: string): string {
  return text.replace(FENCE_TAG_RE, "[REDACTED:fence-tag]");
}


/**
 * Strip obvious instruction-injection patterns AND fence-tag delimiters
 * from untrusted assistant text. Preserves length-ish by replacing with
 * `[REDACTED:reason]`. The fence-tag scrubbing is critical — the
 * judge prompt fences this content with `<prior_assistant_response>` /
 * `<user_intent>` etc., and a malicious assistant that closes the tag
 * could reopen as system context. The instruction-pattern scrubbing is
 * belt-and-braces for the obvious injection vectors.
 */
function sanitiseAssistantContent(text: string): string {
  let out = sanitiseFenceTags(text);
  for (const { re, reason } of INJECTION_PATTERNS) {
    out = out.replace(re, `[REDACTED:${reason}]`);
  }
  return out;
}

/**
 * Combine a user prompt with prior assistant context into the judge's
 * "intent" string. Two regimes:
 *
 *  - Substantive user prompt (≥200 chars or contains punctuation/imperatives):
 *    drop the prior-assistant block entirely. The user has provided enough
 *    context on their own; carrying assistant text just enlarges the
 *    injection surface.
 *
 *  - Short user prompt ("yes", "do that", "option 2"): the assistant's
 *    prior turn is needed for the judge to resolve references. Truncate
 *    aggressively (last 500 chars — usually the question being asked)
 *    and run injection-pattern sanitisation.
 *
 * The output uses explicit, separable tags so the judge prompt can fence
 * trusted vs. untrusted content. See intent-judge.ts evaluate() — it
 * places this whole string inside <user_intent>…</user_intent>.
 */
const PRIOR_ASSISTANT_MAX_CHARS = 500;

export function buildContextualIntent(
  userPrompt: string,
  priorAssistant: string | null
): string {
  // Coerce away undefined/null. The backfill path (applyBackfill) can resolve
  // an undefined last-user prompt from a transcript with no usable user turn;
  // returning undefined here lands as IntentEntry.contextual = undefined, which
  // crashes scrubFenceTags(undefined).replace() in IntentJudge.evaluate and
  // fails the judge soft (drifting -> silent allow). See
  // hooks/tests/test_judge_undefined_intent.ts.
  const prompt = userPrompt ?? "";
  if (!priorAssistant) return prompt;

  // Substantive prompts don't need the prior context. Heuristic: long
  // (≥200 chars) or wordy (≥8 words). At that scale the user has
  // provided enough context that the prior assistant turn would only
  // enlarge the injection surface without changing the judge's verdict.
  const trimmed = prompt.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const isSubstantive = trimmed.length >= 200 || wordCount >= 8;
  if (isSubstantive) {
    return prompt;
  }

  const tail = priorAssistant.length > PRIOR_ASSISTANT_MAX_CHARS
    ? priorAssistant.substring(priorAssistant.length - PRIOR_ASSISTANT_MAX_CHARS)
    : priorAssistant;
  const sanitisedAssistant = sanitiseAssistantContent(tail);
  // User prompts only get fence-tag scrubbing, not the injection-pattern
  // sanitisation — users are allowed to type "ignore previous" if they
  // mean it. But they shouldn't be able to paste `</user_prompt>` and
  // break the fence either, even by accident.
  const sanitisedUser = sanitiseFenceTags(prompt);
  return `<prior_assistant_response>
${sanitisedAssistant}
</prior_assistant_response>

<user_prompt>
${sanitisedUser}
</user_prompt>`;
}
