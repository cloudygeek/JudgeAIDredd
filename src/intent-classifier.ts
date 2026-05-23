/**
 * Async LLM intent classifier.
 *
 * Step 4 of the history-active migration. Takes the same inputs as
 * the synchronous embedding classifier and runs them through a real
 * LLM (Bedrock Claude Sonnet) for nuanced classification. Designed
 * to run AFTER /intent has returned its response — the embedding
 * classifier provides a provisional verdict that becomes the active
 * state immediately, and this module's verdict overrides it on the
 * next /evaluate if the LLM disagrees at high confidence.
 *
 * The hot path stays at ~200ms; the LLM call adds 1.5–2.5s in the
 * background, hidden from the user behind the agent's own response
 * latency.
 *
 * Failure modes (timeout, malformed output, Bedrock outage) collapse
 * gracefully to the embedding fallback — caller never gets stuck.
 */

import { bedrockChat } from "./bedrock-client.js";
import { chat } from "./ollama-client.js";
import type { IntentEntry } from "./session-store.js";
import type { JudgeBackend } from "./intent-judge.js";

/** Soft timeout for the LLM call. Beyond this we abandon the
 *  classifier and the embedding fallback persists. 15s comfortably
 *  covers Sonnet 4.6 at P95 (~3-4s) and tolerates Bedrock spikes
 *  without queueing requests forever. */
const CLASSIFIER_SOFT_TIMEOUT_MS = 15_000;

/** Hard cap on the in-memory pendingClassifications map. Beyond this
 *  many concurrent in-flight classifications, drop the oldest pending
 *  promise — a runaway session count would otherwise leak memory. */
const MAX_PENDING_CLASSIFICATIONS = 500;

export type ClassifierKind =
  | "original"
  | "confirmation"
  | "queued"
  | "open-followup"
  | "continuation"
  | "new-task"
  | "sub-task"
  | "replacement"
  | "revisit";

export type ClassifierConfidence = "high" | "medium" | "low";

export interface ClassifierVerdict {
  kind: ClassifierKind;
  /** For revisit/replacement/sub-task — the historical entry id this
   *  prompt acts on. Required for revisit (which entry to revive) and
   *  replacement (which entry to mark resolved). For sub-task, the
   *  parent entry's id; the active set logic doesn't strictly need
   *  it but the dashboard renders parent/child links from it. */
  referencedEntryId?: string;
  /** "high" for unambiguous classifications, "low" when the LLM is
   *  guessing. Only "high" verdicts overrule the embedding fallback;
   *  "medium"/"low" are recorded for telemetry and ignored. */
  confidence: ClassifierConfidence;
  /** One-sentence justification, kept for telemetry + dashboard. */
  reasoning: string;
  /** Round-trip time including parser; useful when investigating
   *  Bedrock latency drift. */
  durationMs: number;
}

const SYSTEM_PROMPT = `You are an intent-tracker classifier. Your job is to look at a user's NEW prompt to a coding agent, the agent's CURRENTLY ACTIVE goals, and a sample of RECENT HISTORICAL goals (some resolved), and classify the new prompt into one of these kinds:

- "original" — the very first prompt of a session. Never returned here; the caller handles this case.
- "continuation" — the new prompt refines or progresses on the most recent active goal. Same conceptual goal, just more detail / next step.
- "sub-task" — the new prompt introduces a child task that is scoped UNDER an active parent goal. Parent stays alive; child is added. Look for "first ...", "before that ...", "quickly fix X then continue".
- "replacement" — the new prompt SUPERSEDES an active goal. The user has changed their mind about the most recent goal; mark it resolved and adopt the new one. Look for "actually do X instead", "wait, do Y", "never mind, fix Z".
- "revisit" — the new prompt RETURNS the user to a previously-resolved historical goal. The historical goal becomes live again. Look for "go back to ...", "let's resume the X work", "back to that bug".
- "new-task" — a true topic switch with no relationship to any active or recent historical goal. Wipe everything and start fresh.
- "queued" — the prompt arrived while the agent is mid-tool-call. The agent will combine it with the in-flight generation. (You will be told this happened via turn_state="draining".)
- "open-followup" — the prompt arrived between Stop and the next tool call but the agent hasn't finished generating. (You will be told turn_state="open".)

Rules:
1. If turn_state is "draining" → ALWAYS return "queued".
2. If turn_state is "open" → ALWAYS return "open-followup".
3. For revisit/replacement/sub-task you MUST also return the id of the active or historical entry being acted on (the parent for sub-task, the goal being replaced for replacement, the goal being revived for revisit).
4. confidence:
   - "high" — unambiguous case, embedding-only would also get it right OR you are certain
   - "medium" — best guess but ambiguous; could plausibly be a different kind
   - "low" — guessing; embedding fallback is probably equally good

Respond with ONLY valid JSON in this exact shape (no markdown fences, no commentary):

{"kind": "...", "referencedEntryId": "..." (omit if not applicable), "confidence": "high|medium|low", "reasoning": "..."}`;

function buildUserMessage(
  prompt: string,
  active: IntentEntry[],
  history: IntentEntry[],
  turnState: "open" | "draining" | "closed",
): string {
  const formatEntry = (e: IntentEntry, i: number): string => {
    const tag = e.resolved ? " [resolved]" : "";
    const id = e.id ? ` id=${e.id.substring(0, 8)}` : "";
    return `  ${i + 1}. ${e.kind}${id}${tag}: "${e.prompt.substring(0, 200).replace(/\n/g, " ")}"`;
  };
  // Show active first, then a recent slice of resolved history. Cap
  // both to keep input token count bounded — the system prompt + 5
  // active + 10 historical + the new prompt fits comfortably under
  // the 2500-token target from the design doc.
  const activeBlock =
    active.length > 0
      ? active.map(formatEntry).join("\n")
      : "  (none)";
  const activeIds = new Set(active.map((e) => e.id).filter(Boolean));
  const recentResolved = history
    .filter((e) => e.id && !activeIds.has(e.id))
    .slice(-10);
  const historyBlock =
    recentResolved.length > 0
      ? recentResolved.map(formatEntry).join("\n")
      : "  (none)";
  return [
    `turn_state: ${turnState}`,
    "",
    "Currently active goals:",
    activeBlock,
    "",
    "Recent historical goals (some resolved):",
    historyBlock,
    "",
    `New user prompt: "${prompt.substring(0, 1000)}"`,
    "",
    "Classify the new prompt. Respond with the JSON only.",
  ].join("\n");
}

/** Tolerant JSON parse — strips markdown fences and trailing prose
 *  if the LLM ignored the format instruction. Returns null on
 *  unrecoverable garbage. */
function parseClassifierOutput(raw: string): {
  kind: ClassifierKind;
  referencedEntryId?: string;
  confidence: ClassifierConfidence;
  reasoning: string;
} | null {
  let text = raw.trim();
  // Strip ``` or ```json fences if present.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // Find the first { ... } that parses cleanly. Bedrock occasionally
  // adds a one-line preamble like "Here is the classification:" before
  // the JSON.
  const firstBrace = text.indexOf("{");
  if (firstBrace > 0) text = text.slice(firstBrace);
  // If the LLM trailed off with extra prose after the JSON, find the
  // matching closing brace.
  let depth = 0;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end > 0) text = text.slice(0, end + 1);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const kind = parsed.kind;
  if (
    kind !== "original" &&
    kind !== "confirmation" &&
    kind !== "queued" &&
    kind !== "open-followup" &&
    kind !== "continuation" &&
    kind !== "new-task" &&
    kind !== "sub-task" &&
    kind !== "replacement" &&
    kind !== "revisit"
  ) {
    return null;
  }
  const confidence = parsed.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    return null;
  }
  const referencedEntryId =
    typeof parsed.referencedEntryId === "string" && parsed.referencedEntryId.length > 0
      ? parsed.referencedEntryId
      : undefined;
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  return { kind, referencedEntryId, confidence, reasoning };
}

export class IntentClassifier {
  private backend: JudgeBackend;
  private model: string;

  constructor(backend: JudgeBackend = "bedrock", model = "eu.anthropic.claude-sonnet-4-6") {
    this.backend = backend;
    this.model = model;
  }

  /**
   * Run the classifier. Returns null on any failure (timeout, parse
   * error, Bedrock outage). Caller treats null as "embedding fallback
   * stays in place" rather than failing the request.
   */
  async classify(
    prompt: string,
    active: IntentEntry[],
    history: IntentEntry[],
    turnState: "open" | "draining" | "closed",
  ): Promise<ClassifierVerdict | null> {
    const start = Date.now();
    const userMessage = buildUserMessage(prompt, active, history, turnState);

    let raw: string;
    try {
      const result = await Promise.race([
        this.backend === "bedrock"
          ? bedrockChat(SYSTEM_PROMPT, userMessage, this.model, undefined, undefined, "classifier")
          : chat(
              [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMessage },
              ],
              this.model,
            ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`classifier timeout (${CLASSIFIER_SOFT_TIMEOUT_MS}ms)`)),
            CLASSIFIER_SOFT_TIMEOUT_MS,
          ),
        ),
      ]);
      raw = (result as any).content ?? "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [intent-classifier] backend ${this.backend} failed: ${msg}`);
      return null;
    }

    const parsed = parseClassifierOutput(raw);
    if (!parsed) {
      console.warn(
        `  [intent-classifier] failed to parse output (${raw.substring(0, 200).replace(/\n/g, " ")}...)`,
      );
      return null;
    }
    return {
      ...parsed,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * In-memory map of session id → currently in-flight classifier
 * promise. /evaluate looks up its session here and awaits with a
 * bounded timeout before falling back to the cached active state.
 *
 * Bounded by MAX_PENDING_CLASSIFICATIONS to defend against runaway
 * leaks if many sessions trigger classifications back-to-back. Eviction
 * is FIFO by insertion order — Map preserves insertion order so we
 * just delete the first key when over cap.
 */
const pendingClassifications = new Map<string, Promise<ClassifierVerdict | null>>();

export function setPendingClassification(
  sessionId: string,
  promise: Promise<ClassifierVerdict | null>,
): void {
  pendingClassifications.set(sessionId, promise);
  if (pendingClassifications.size > MAX_PENDING_CLASSIFICATIONS) {
    const oldest = pendingClassifications.keys().next().value;
    if (oldest) pendingClassifications.delete(oldest);
  }
  // Auto-clean: when the promise settles, remove it from the map.
  // We use the same promise reference (not a wrapper) so a callsite
  // awaiting it from /evaluate sees the same value.
  promise
    .catch(() => null)
    .finally(() => {
      // Only remove if it's still the current promise — a fresh
      // /intent on the same session may have replaced it.
      if (pendingClassifications.get(sessionId) === promise) {
        pendingClassifications.delete(sessionId);
      }
    });
}

/**
 * Wait up to maxWaitMs for the session's pending classification to
 * resolve. Returns null on timeout (caller falls back to embedding
 * verdict) or if no classification was pending.
 */
export async function awaitPendingClassification(
  sessionId: string,
  maxWaitMs: number,
): Promise<ClassifierVerdict | null> {
  const promise = pendingClassifications.get(sessionId);
  if (!promise) return null;
  try {
    const result = await Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), maxWaitMs)),
    ]);
    return result;
  } catch {
    return null;
  }
}

/**
 * Cancel any pending classification for the session. Called by /end
 * (closed session — no point classifying) and /pivot (user changed
 * direction explicitly, the classifier verdict for the prompt that
 * predated the pivot is no longer relevant).
 *
 * The in-flight Bedrock call can't actually be cancelled (no AbortController
 * threaded through), but removing it from the pending map means /evaluate
 * won't wait on it; the verdict, when it lands, will see the session is
 * gone and silently no-op.
 */
export function cancelPendingClassification(sessionId: string): void {
  pendingClassifications.delete(sessionId);
}
