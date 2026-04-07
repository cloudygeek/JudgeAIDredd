/**
 * Ollama Client
 *
 * Lightweight HTTP client for Ollama's local API.
 * Provides embedding generation and chat completion
 * without any external dependencies.
 */

const OLLAMA_BASE = process.env.OLLAMA_HOST ?? "http://localhost:11434";

export interface EmbeddingResponse {
  embeddings: number[][];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
    body: JSON.stringify({ model, messages, stream: false }),
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
