/**
 * Ollama Client
 *
 * Lightweight HTTP client for Ollama's local API.
 * Provides embedding generation and chat completion
 * without any external dependencies.
 */

const OLLAMA_BASE = process.env.OLLAMA_HOST ?? "http://localhost:11434";

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
 * Both assume a resident model — cold start is ~22s, so a local deployment
 * wants OLLAMA_KEEP_ALIVE set long.
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
    body: JSON.stringify({ model, input }),
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
 */
export async function chat(
  messages: ChatMessage[],
  model = "llama3.2"
): Promise<{ content: string; durationMs: number }> {
  const start = Date.now();

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      ...(OLLAMA_THINK === undefined ? {} : { think: OLLAMA_THINK }),
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
