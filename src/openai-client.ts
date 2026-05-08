/**
 * OpenAI Client — minimal chat-completions wrapper.
 *
 * Used by PromptArmorBaseline (and any future OpenAI-backed feature) for
 * single-call detector-style requests: system prompt + one user message,
 * no tools, no streaming, deterministic temperature. Mirrors the
 * shape of bedrock-client.ts so callers can swap backends with the
 * same surface.
 *
 * Uses the global fetch (Node 22+) to avoid adding the openai SDK as
 * a runtime dependency. The chat-completions API surface is stable
 * enough for this.
 *
 * Caller responsibilities:
 *   - Set OPENAI_API_KEY in env. We do not read this at module load
 *     so the absence is a per-call failure rather than a startup crash.
 *   - Pick the model. We don't map friendly aliases here (executor-
 *     openai.ts has a MODEL_MAP for that — caller-side concern).
 */

interface OpenAIChatResponse {
  choices: Array<{
    message: { content: string | null };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatResult {
  content: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finishReason: string;
}

export async function openaiChat(
  systemPrompt: string,
  userMessage: string,
  modelId: string,
  opts: {
    /** Defaults to 0 for deterministic detector-style use. */
    temperature?: number;
    /** Cap on output tokens. */
    maxTokens?: number;
    /** Per-call abort timeout in ms; default 60s. */
    timeoutMs?: number;
  } = {},
): Promise<OpenAIChatResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const body = {
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 256,
  };

  const start = Date.now();
  const maxAttempts = 3;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
          const backoff = 1000 * Math.pow(2, attempt - 1);
          console.warn(
            `  [openai ${res.status}] attempt ${attempt}/${maxAttempts}; sleeping ${backoff}ms`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw new Error(`OpenAI HTTP ${res.status}: ${text.substring(0, 500)}`);
      }

      const json = (await res.json()) as OpenAIChatResponse;
      const choice = json.choices?.[0];
      const content = choice?.message?.content ?? "";
      const usage = json.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      return {
        content,
        durationMs: Date.now() - start,
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        finishReason: choice?.finish_reason ?? "unknown",
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const backoff = 1000 * Math.pow(2, attempt - 1);
        console.warn(
          `  [openai fetch] attempt ${attempt}/${maxAttempts}: ${lastErr.message}; sleeping ${backoff}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("OpenAI call failed with no captured error");
}
