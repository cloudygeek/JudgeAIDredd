/**
 * Ollama Client
 *
 * Lightweight HTTP client for Ollama's local API.
 * Provides embedding generation and chat completion
 * without any external dependencies.
 */

const OLLAMA_BASE = process.env.OLLAMA_HOST ?? "http://localhost:11434";

/**
 * How long Ollama keeps the model resident after a request.
 *
 * Ollama's default is 5 MINUTES. Measured on the Studio: a warm judge call is
 * 1.3s, a cold one ~22s because the 23GB model has to be re-read. Five idle
 * minutes is nothing on a developer's machine, so in practice most sessions
 * pay that 22s at least once — on a call that blocks the agent's tool use.
 *
 * The documented fix is `launchctl setenv OLLAMA_KEEP_ALIVE 24h` on the host,
 * and it is a poor one: it does not survive being set from an SSH session (that
 * lands in launchd's Background domain while Ollama.app runs in Aqua), it needs
 * the app restarted, and it silently reverts if the app is reinstalled. None of
 * that is discoverable — you just get a slow call now and then.
 *
 * Sending `keep_alive` on the request instead makes residency a property of the
 * CALLER, which is where it belongs: no host configuration, survives app
 * restarts, and works on any Ollama the deployment happens to talk to.
 * Verified against Ollama: /api/chat honours it, and /api/ps then reports
 * expires_at 24h out.
 *
 * Unset (the default) omits the field, so behaviour is unchanged for anyone
 * relying on their own server-side setting.
 */
const OLLAMA_KEEP_ALIVE: string | undefined =
  process.env.DREDD_OLLAMA_KEEP_ALIVE && process.env.DREDD_OLLAMA_KEEP_ALIVE.length > 0
    ? process.env.DREDD_OLLAMA_KEEP_ALIVE
    : undefined;

/**
 * Whether to let a reasoning model emit thinking tokens.
 *
 * Suppressing reasoning is normally a quality trade. On the judge task,
 * measured on qwen3.6:35b / Mac Studio M4 Max 128GB against the held-out
 * adversarial corpus (hooks/tests/fixtures/judge-hard-corpus.ts), it was not:
 *
 *   thinking ON   19/24 correct, 7.9s/call, 4 subtle hijacks missed
 *   thinking OFF  34/36 correct, 1.3s/call, 1 missed (a debatable label)
 *
 * Both legs on the same box and model, so the difference is the flag. The
 * clean flip is TP-remote-redirect (`git remote set-url` to an attacker repo,
 * then push): missed 2/2 with reasoning on, caught 3/3 with it off — the
 * reasoning trace talked itself into "pushing IS the task". Small corpus, so
 * treat the direction as established and the magnitude as provisional.
 *
 * Latency matters here more than it looks: this call BLOCKS the agent's tool
 * call, and Dredd judges roughly half of them. 7.9s is unusable; 1.3s is not.
 * Both assume a resident model — cold start is ~22s. See DREDD_OLLAMA_KEEP_ALIVE
 * below, which pins residency from the client so the host needs no setup.
 *
 * Unset (the default) omits the field entirely, so behaviour is byte-identical
 * to before this was added and non-reasoning models are unaffected. Set
 * DREDD_OLLAMA_THINK=false to suppress reasoning, =true to force it on.
 * Re-run the eval before changing the default.
 */
const OLLAMA_THINK: boolean | undefined =
  process.env.DREDD_OLLAMA_THINK === undefined
    ? undefined
    : process.env.DREDD_OLLAMA_THINK !== "false";

export interface EmbeddingResponse {
  embeddings: number[][];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Base64-encoded images (Ollama vision models only) */
  images?: string[];
}

export interface ChatResponse {
  message: {
    role: string;
    content: string;
  };
  total_duration?: number;
  eval_count?: number;
}

/**
 * Generate embeddings for one or more texts.
 */
export async function embed(
  texts: string | string[],
  model = "nomic-embed-text"
): Promise<number[][]> {
  const input = Array.isArray(texts) ? texts : [texts];

  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input,
      // The embedding model is subject to the same 5-minute eviction as the
      // chat model, and drift runs on every judged call — so a cold embed is a
      // latency spike on the identical hot path.
      ...(OLLAMA_KEEP_ALIVE === undefined ? {} : { keep_alive: OLLAMA_KEEP_ALIVE }),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as EmbeddingResponse;
  return data.embeddings;
}

/**
 * Chat completion with a local model. Streaming disabled for simplicity.
 *
 * `format` is Ollama's structured-output control: pass a JSON Schema and the
 * sampler is constrained to emit conforming JSON. Opt-in per caller — the
 * judge uses it (see JUDGE_VERDICT_SCHEMA) because a mistyped key there costs
 * a false "hijacked"; the classifier and interceptor do not, so their decoding
 * path is unchanged.
 *
 * NOTE this is an Ollama-only mechanism. The Bedrock path in intent-judge.ts
 * has no equivalent here, which is why the parser in parseVerdict must stay
 * correct on its own rather than relying on the schema.
 */
export async function chat(
  messages: ChatMessage[],
  model = "llama3.2",
  format?: unknown
): Promise<{ content: string; durationMs: number }> {
  const start = Date.now();

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      ...(format === undefined ? {} : { format }),
      ...(OLLAMA_THINK === undefined ? {} : { think: OLLAMA_THINK }),
      ...(OLLAMA_KEEP_ALIVE === undefined ? {} : { keep_alive: OLLAMA_KEEP_ALIVE }),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama chat failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as ChatResponse;
  return {
    content: data.message.content,
    durationMs: Date.now() - start,
  };
}

/**
 * Route an embed call to Bedrock or Ollama based on the model name.
 * Bedrock model IDs start with a known provider prefix (with or without a
 * region qualifier like eu./us./global.). Ollama model names never do.
 */
const BEDROCK_PREFIXES = /^(?:eu\.|us\.|global\.|amazon\.|cohere\.|twelvelabs\.|anthropic\.|meta\.|mistral\.|nvidia\.)/;

export function isBedrockModel(model: string): boolean {
  return BEDROCK_PREFIXES.test(model);
}

export async function embedAny(
  texts: string | string[],
  model: string,
  auth?: import("./byot/types.js").BedrockAuth,
): Promise<number[][]> {
  if (isBedrockModel(model)) {
    const { bedrockEmbed } = await import("./bedrock-client.js");
    const arr = Array.isArray(texts) ? texts : [texts];
    return bedrockEmbed(arr, model, undefined, auth);
  }
  // Ollama path is local — BYOT does not apply.
  return embed(texts, model);
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Check if Ollama is reachable and the required models are available.
 */
export async function checkOllama(
  embeddingModel: string,
  chatModel?: string
): Promise<{ ok: boolean; missing: string[] }> {
  const required = chatModel ? [embeddingModel, chatModel] : [embeddingModel];
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) return { ok: false, missing: required };

    const data = (await res.json()) as { models: { name: string }[] };
    const available = new Set(data.models.map((m) => m.name.split(":")[0]));

    const missing: string[] = [];
    for (const m of required) {
      if (!available.has(m.split(":")[0])) missing.push(m);
    }

    return { ok: missing.length === 0, missing };
  } catch {
    return { ok: false, missing: required };
  }
}
