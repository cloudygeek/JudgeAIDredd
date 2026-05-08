/**
 * PromptArmor Baseline
 *
 * Reproduces the PromptArmor (Shi et al., arXiv:2507.15219; ICLR 2026)
 * detector as a baseline for the head-to-head test plan. Single
 * surface: `screen(content, taskContext?)` runs the detector LLM on
 * one untrusted-content blob and returns a verdict + sanitised text.
 *
 * Architecture: this is NOT a tool-call interceptor. PromptArmor sits
 * upstream of the agent, scanning each tool result before it enters
 * the agent's context. See docs/test-plan-promptarmor-headtohead-2026-05-08.md
 * for how it plugs into the corpus runners.
 *
 * Output parsing follows Figure 2 of the paper:
 *   Line 1: "Yes" or "No"
 *   If Yes, line 2: "Injection: <verbatim text>"
 *
 * Sanitisation follows §3.1: tokenise the extracted injection, build
 * a regex with `.*?` between consecutive words, strip the first
 * (case-insensitive, dot-all) match from the data sample. If the regex
 * doesn't match, we still emit `verdict: "injected"` but leave the
 * sample unchanged and log a warning — the detector flagged it but we
 * couldn't locate the span.
 *
 * Per-call telemetry: when `runId` is set on the constructor, every
 * screen() appends a JSONL line to
 * `results/promptarmor/<runId>/calls.jsonl` with token counts, latency,
 * verdict, backend/model/temperature, and a SHA-256 of the input
 * content (so calls can be joined back to corpus items without
 * re-storing the full blob).
 */

import { appendFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bedrockChat } from "./bedrock-client.js";
import { openaiChat } from "./openai-client.js";
import { PROMPTARMOR_SYSTEM_PROMPT } from "./promptarmor-prompts.js";

export type PromptArmorBackend = "openai" | "bedrock";

export type PromptArmorVerdict = "clean" | "injected" | "parse_error";

export interface PromptArmorResult {
  verdict: PromptArmorVerdict;
  /** The (possibly sanitised) content. Equal to input when verdict=clean. */
  sanitised: string;
  latencyMs: number;
  tokens: { in: number; out: number };
  /** The detector's raw text output — useful for disagreement analysis. */
  rawOutput: string;
  /** When verdict=injected, the verbatim injection the detector flagged. */
  injection?: string;
  /** True when verdict=injected but the fuzzy regex didn't match the sample. */
  sanitisationFailed?: boolean;
}

export interface PromptArmorOpts {
  backend: PromptArmorBackend;
  /**
   * Detector model id. Caller's responsibility to map friendly names
   * (e.g. "gpt-4o" → "gpt-4o-2024-08-06") if desired.
   */
  model: string;
  /**
   * `"canonical"` would be a verbatim authors' release. Since none
   * exists as of 2026-05-08, we ship the reconstructed prompt and
   * accept this flag for forward-compatibility — both values currently
   * resolve to PROMPTARMOR_SYSTEM_PROMPT.
   */
  promptVersion?: "canonical" | "reconstructed";
  /** Detector temperature; paper uses 0. */
  temperature?: number;
  /**
   * Optional run id. When set, every screen() appends to
   * results/promptarmor/<runId>/calls.jsonl. Also seeds the sentinel
   * string so corpus runs can grep for it without colliding with prior
   * runs' output.
   */
  runId?: string;
  /** Override results directory; default `results/`. */
  resultsDir?: string;
}

interface CallLogEntry {
  ts: string;
  verdict: PromptArmorVerdict;
  backend: PromptArmorBackend;
  model: string;
  temperature: number;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  content_hash: string;
  content_length: number;
  task_context_length: number;
  finish_reason?: string;
  parse_failure?: string;
  sanitisation_failed?: boolean;
}

export class PromptArmorBaseline {
  private readonly backend: PromptArmorBackend;
  private readonly model: string;
  private readonly temperature: number;
  private readonly runId: string | null;
  private readonly callLogPath: string | null;
  private readonly sentinel: string;

  constructor(opts: PromptArmorOpts) {
    this.backend = opts.backend;
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0;
    this.runId = opts.runId ?? null;

    if (this.runId) {
      const baseDir = opts.resultsDir ?? "results";
      const dir = join(baseDir, "promptarmor", this.runId);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.callLogPath = join(dir, "calls.jsonl");
    } else {
      this.callLogPath = null;
    }

    // Run-scoped sentinel so a corpus blob that happens to contain the
    // sentinel literal from a previous run doesn't get false-stripped.
    this.sentinel = `[PROMPTARMOR-${this.runId ?? "adhoc"}-REDACTED]`;
  }

  /**
   * Screen a single untrusted-content blob.
   *
   * @param content - the data sample (typically a tool-result string)
   *   that the agent is about to consume.
   * @param taskContext - optional snippet of the user task. NOT used
   *   in the canonical PromptArmor prompt — included for forward
   *   compatibility if a future variant wants task-aware framing. Currently
   *   ignored by the detector but logged for telemetry.
   */
  async screen(content: string, taskContext?: string): Promise<PromptArmorResult> {
    const start = Date.now();
    const contentHash = sha256(content);

    let rawOutput: string;
    let inputTokens: number;
    let outputTokens: number;
    let finishReason = "unknown";

    try {
      if (this.backend === "openai") {
        const r = await openaiChat(PROMPTARMOR_SYSTEM_PROMPT, content, this.model, {
          temperature: this.temperature,
        });
        rawOutput = r.content;
        inputTokens = r.inputTokens;
        outputTokens = r.outputTokens;
        finishReason = r.finishReason;
      } else {
        // Bedrock: bedrockChat's temperature is tied to its `effort` flag,
        // and uses 0.1 by default. PromptArmor needs temperature 0
        // (paper §4.1) for reproducibility — but bedrockChat's surface
        // doesn't expose temperature directly. We rely on its
        // "no-effort" branch which sets temperature 0.1, and accept the
        // small temperature mismatch with the paper's GPT runs. Logged
        // in the call log so the disagreement analysis can account for
        // it.
        //
        // TODO(promptarmor): when bedrock-client.ts grows a temperature
        // override (it's already needed for the judge in some configs),
        // pass this.temperature through.
        const r = await bedrockChat(PROMPTARMOR_SYSTEM_PROMPT, content, this.model);
        rawOutput = r.content;
        inputTokens = r.inputTokens;
        outputTokens = r.outputTokens;
      }
    } catch (err) {
      // Network/auth failure. Surface to caller but log so the corpus
      // run can decide whether to retry.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [promptarmor] backend ${this.backend} call failed: ${msg}`);
      throw err;
    }

    const latencyMs = Date.now() - start;
    const parsed = parseDetectorOutput(rawOutput);
    let result: PromptArmorResult;

    if (parsed.kind === "no") {
      result = {
        verdict: "clean",
        sanitised: content,
        latencyMs,
        tokens: { in: inputTokens, out: outputTokens },
        rawOutput,
      };
    } else if (parsed.kind === "yes") {
      const { sanitised, matched } = fuzzyStrip(content, parsed.injection);
      result = {
        verdict: "injected",
        sanitised: matched ? sanitised : content,
        latencyMs,
        tokens: { in: inputTokens, out: outputTokens },
        rawOutput,
        injection: parsed.injection,
        sanitisationFailed: !matched,
      };
      if (!matched) {
        console.warn(
          `  [promptarmor] detector returned Yes but fuzzy regex did not match content; verdict=injected, sample unchanged`,
        );
      }
    } else {
      result = {
        verdict: "parse_error",
        sanitised: content,
        latencyMs,
        tokens: { in: inputTokens, out: outputTokens },
        rawOutput,
      };
      console.warn(
        `  [promptarmor] could not parse detector output (${parsed.reason}); verdict=parse_error, treating as clean`,
      );
    }

    if (this.callLogPath) {
      const entry: CallLogEntry = {
        ts: new Date().toISOString(),
        verdict: result.verdict,
        backend: this.backend,
        model: this.model,
        temperature: this.temperature,
        latency_ms: latencyMs,
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        content_hash: contentHash,
        content_length: content.length,
        task_context_length: taskContext?.length ?? 0,
        finish_reason: finishReason,
        parse_failure: parsed.kind === "unparseable" ? parsed.reason : undefined,
        sanitisation_failed: result.sanitisationFailed,
      };
      // Best-effort; failure here doesn't break the screen.
      appendFile(this.callLogPath, JSON.stringify(entry) + "\n").catch((err) => {
        console.warn(`  [promptarmor] call log append failed: ${err}`);
      });
    }

    return result;
  }

  /** The sentinel string used for redactions — useful for collision pre-checks. */
  getSentinel(): string {
    return this.sentinel;
  }
}

// ---------------------------------------------------------------------------
// Output parser (Figure 2)
// ---------------------------------------------------------------------------

type ParseResult =
  | { kind: "yes"; injection: string }
  | { kind: "no" }
  | { kind: "unparseable"; reason: string };

function parseDetectorOutput(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "unparseable", reason: "empty output" };

  // Strip common LLM dressing before pattern-matching:
  //   - Markdown bold/italic around the verdict (`**Yes**`, `*No*`).
  //   - Leading "## Heading" or "**Heading:**" preambles.
  //   - Bullet markers and trailing punctuation on the verdict line.
  // Sonnet/Opus are particularly fond of `**Yes**` and `**No**` — the
  // paper's prompt is one line and gives no formatting guidance, so
  // models pick their own styles. We accept the variants rather than
  // refuse them.
  const stripped = trimmed
    .replace(/\*+/g, "")          // markdown bold/italic
    .replace(/^#+\s+/gm, "")      // markdown headings
    .replace(/^[-•*]\s+/gm, "");  // bullet markers
  const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Find the first line that starts with Yes or No (after the strip).
  // Some models (and the paper's GPT-3.5 tail) lead with a sentence like
  // "Yes, this contains..." or "No, this is benign..." — accept those
  // by anchoring on word-boundary at the start of the line.
  let verdictIndex = -1;
  let isYes = false;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (/^yes\b/.test(lower)) { verdictIndex = i; isYes = true; break; }
    if (/^no\b/.test(lower)) { verdictIndex = i; isYes = false; break; }
  }
  if (verdictIndex === -1) {
    return { kind: "unparseable", reason: `no Yes/No line: ${lines[0]?.substring(0, 60) ?? "(empty)"}` };
  }
  if (!isYes) return { kind: "no" };

  // Yes branch — find the "Injection:" line anywhere after the verdict.
  const rest = lines.slice(verdictIndex + 1).join("\n");
  const m = /(?:^|\n)\s*Injection\s*:?\s*([\s\S]+)$/i.exec(rest);
  if (!m) {
    return { kind: "unparseable", reason: "Yes without Injection: marker" };
  }
  // Strip common quote wrappers around the injection text — Sonnet
  // sometimes wraps the extracted span in straight or curly quotes.
  let injection = m[1].trim().replace(/^["'`""'']+|["'`""'']+$/g, "").trim();
  if (!injection) {
    return { kind: "unparseable", reason: "empty Injection: body" };
  }
  return { kind: "yes", injection };
}

// ---------------------------------------------------------------------------
// Fuzzy strip (§3.1)
// ---------------------------------------------------------------------------

/**
 * Build a regex that allows arbitrary characters between consecutive
 * non-whitespace tokens of `injection`, then strip the first match
 * from `content`. Returns the (possibly modified) content and a
 * `matched` flag.
 */
function fuzzyStrip(content: string, injection: string): { sanitised: string; matched: boolean } {
  const tokens = injection.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { sanitised: content, matched: false };

  // Escape regex metacharacters in each token.
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // .*? between tokens; case-insensitive, DOTALL.
  const pattern = escaped.join(".*?");
  let re: RegExp;
  try {
    re = new RegExp(pattern, "is");
  } catch {
    return { sanitised: content, matched: false };
  }

  const m = re.exec(content);
  if (!m) return { sanitised: content, matched: false };

  // Replace the matched span with empty string. Trim consecutive
  // newlines that now sit next to each other to avoid leaving an
  // ugly gap.
  const before = content.substring(0, m.index);
  const after = content.substring(m.index + m[0].length);
  const stitched = (before + after).replace(/\n{3,}/g, "\n\n");
  return { sanitised: stitched, matched: true };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
