/**
 * Bedrock Client
 *
 * Calls the judge LLM (Sonnet/Nemotron/etc.) via Bedrock's Converse API
 * and embedding models via InvokeModel. Uses the AWS SDK directly so the
 * call is async (non-blocking) and the credential chain is the standard
 * Node SDK chain (env vars, shared config, IRSA / IMDSv2 on Fargate).
 *
 * History: this used to shell out to `aws bedrock-runtime ...` via
 * `execSync` with temp-file payloads. That was 1-concurrency (the event
 * loop blocked for ~1.5s per judge call) and added a 150–300 ms
 * process-spawn cost on every invocation. Replacing with the SDK fixes
 * both. See also task #12 / commit history.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const REGION = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "eu-central-1";
const MODEL_ID = process.env.BEDROCK_JUDGE_MODEL ?? "nvidia.nemotron-super-3-120b";

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "none";

export interface BedrockImageBlock {
  /** Base64-encoded image data */
  data: string;
  /** MIME type, e.g. "image/png" */
  mediaType: string;
}

// Module-level client per region. Most calls use the same region, so this
// is effectively a singleton with a fallback for cross-region embeddings
// (e.g. judge in eu-west-2, embeddings in eu-west-1).
const clients = new Map<string, BedrockRuntimeClient>();
function clientFor(region: string): BedrockRuntimeClient {
  let c = clients.get(region);
  if (!c) {
    c = new BedrockRuntimeClient({ region });
    clients.set(region, c);
  }
  return c;
}

export async function bedrockChat(
  systemPrompt: string,
  userMessage: string,
  modelId = MODEL_ID,
  effort?: EffortLevel,
  images?: BedrockImageBlock[]
): Promise<{
  content: string;
  thinking: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  hasThinkingBlock: boolean;
  estimatedThinkingTokens: number;
}> {
  const start = Date.now();
  if (effort === "none") effort = undefined;

  // Build user content (text + optional images).
  const userContent: any[] = [{ text: userMessage }];
  if (images?.length) {
    for (const img of images) {
      const format = img.mediaType.replace("image/", "");
      // SDK requires `bytes` to be a Uint8Array, not a base64 string.
      const bytes = Buffer.from(img.data, "base64");
      userContent.push({ image: { format, source: { bytes } } });
    }
  }

  const budgetMap: Record<string, number> = { low: 1024, medium: 5000, high: 16000, max: 60000 };
  const budgetTokens = budgetMap[effort!] ?? 5000;
  const isOpus47 = modelId.includes("opus-4-7");
  const inferenceConfig: Record<string, unknown> = {
    maxTokens: effort ? (isOpus47 ? 16384 : Math.min(budgetTokens + 4096, 64000)) : 512,
  };
  if (!isOpus47) inferenceConfig.temperature = effort ? 1 : 0.1;

  // SDK types `additionalModelRequestFields` as `DocumentType` which doesn't
  // accept conditional shapes cleanly — cast to any. The wire format is
  // model-runtime-defined (Anthropic vs Nova etc.), so the SDK leaves it open.
  const additionalModelRequestFields: any = effort
    ? (isOpus47
        ? { thinking: { type: "adaptive" }, output_config: { effort } }
        : { thinking: { type: "enabled", budget_tokens: budgetTokens } })
    : undefined;

  // Prompt caching: mark the system prompt as a cache point so the
  // 6500-token B7.1 hardened prompt is billed at 10% of the input rate
  // for the next 5 minutes (cache TTL). The cache key is "everything
  // before this marker"; the per-call user message after it is billed
  // normally.
  //
  // Only effective when the cached portion is >= ~1024 tokens (Bedrock
  // minimum). The standard SYSTEM_PROMPT may fall under that threshold
  // and Bedrock will silently skip caching — that's fine, the marker
  // costs nothing on a no-op.
  //
  // We do NOT mark a cache point inside the user content because that
  // changes per call (tool input, file context, agent reasoning) — caching
  // it would invalidate every time. The system prompt is the static
  // 90%+ of every judge request.
  const systemBlocks: any[] = [
    { text: systemPrompt },
    { cachePoint: { type: "default" } },
  ];

  const command = new ConverseCommand({
    modelId,
    system: systemBlocks,
    messages: [{ role: "user", content: userContent }],
    inferenceConfig,
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
  });

  const response = await clientFor(REGION).send(command);

  const blocks = (response.output?.message?.content ?? []) as any[];
  const content = blocks
    .filter((c) => c.text !== undefined)
    .map((c) => c.text as string)
    .join("");
  const thinking = blocks
    .filter((c) => c.reasoningContent !== undefined)
    .map((c) => {
      const rc = c.reasoningContent;
      const rt = rc.reasoningText;
      return (rt?.text ?? rc.text ?? "") as string;
    })
    .join("");

  const usage: any = response.usage ?? {};
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const hasThinkingBlock = blocks.some((c) => c.reasoningContent !== undefined);
  return {
    content,
    thinking,
    durationMs: Date.now() - start,
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? (inputTokens + outputTokens),
    cacheReadInputTokens: usage.cacheReadInputTokens ?? undefined,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? undefined,
    hasThinkingBlock,
    estimatedThinkingTokens: thinking ? Math.ceil(thinking.length / 4) : 0,
  };
}

// ============================================================================
// Embedding API
// ============================================================================

/**
 * Embed a batch of texts using a Bedrock embedding model.
 * Dispatches to the correct request/response format per model family.
 */
export async function bedrockEmbed(
  texts: string[],
  modelId: string,
  region = REGION
): Promise<number[][]> {
  // Strip cross-region inference profile prefixes (eu., us., global.) before dispatch
  const bare = modelId.replace(/^(?:eu|us|global)\./, "");

  if (bare.startsWith("cohere.embed")) {
    return cohereEmbed(texts, modelId, region);
  }
  if (bare.startsWith("amazon.titan-embed")) {
    return Promise.all(texts.map((t) => titanEmbed(t, modelId, region)));
  }
  if (bare.startsWith("twelvelabs.")) {
    return Promise.all(texts.map((t) => marengoEmbed(t, modelId, region)));
  }
  throw new Error(`Unknown Bedrock embedding model family: ${modelId}`);
}

async function invokeModel(modelId: string, body: object, region: string): Promise<object> {
  const command = new InvokeModelCommand({
    modelId,
    body: new TextEncoder().encode(JSON.stringify(body)),
    contentType: "application/json",
    accept: "application/json",
  });
  const response = await clientFor(region).send(command);
  // SDK returns response.body as Uint8Array.
  const bytes = response.body as Uint8Array;
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function cohereEmbed(texts: string[], modelId: string, region: string): Promise<number[][]> {
  const resp = (await invokeModel(modelId, { texts, input_type: "search_query" }, region)) as Record<string, unknown>;
  // v3: { embeddings: number[][] }
  // v4: { embeddings: { float: number[][] } }
  const emb = resp.embeddings as number[][] | { float: number[][] };
  return Array.isArray(emb) ? emb : emb.float;
}

async function titanEmbed(text: string, modelId: string, region: string): Promise<number[]> {
  const resp = (await invokeModel(modelId, { inputText: text }, region)) as { embedding: number[] };
  return resp.embedding;
}

async function marengoEmbed(text: string, modelId: string, region: string): Promise<number[]> {
  // Marengo 3.0: { inputType: "text", text: { text: "..." } }
  // Marengo 2.7: { inputType: "text", inputText: "..." }
  const bare = modelId.replace(/^(?:eu|us|global)\./, "");
  const body = bare.includes("marengo-embed-2-7")
    ? { inputType: "text", inputText: text }
    : { inputType: "text", text: { inputText: text } };

  const resp = (await invokeModel(modelId, body, region)) as Record<string, unknown>;
  if (Array.isArray(resp.embedding)) return resp.embedding as number[];
  const data = resp.data as { embedding: number[] }[] | undefined;
  if (data?.[0]?.embedding) return data[0].embedding;
  throw new Error(`Unexpected Marengo response shape: ${JSON.stringify(resp).substring(0, 200)}`);
}

export async function checkBedrock(modelId = MODEL_ID): Promise<boolean> {
  // Test with a real Converse call — avoids needing metadata API permissions
  // (bedrock:ListInferenceProfiles, bedrock:GetFoundationModel).
  try {
    const command = new ConverseCommand({
      modelId,
      messages: [{ role: "user", content: [{ text: "ok" }] }],
      inferenceConfig: { maxTokens: 1 },
    });
    await clientFor(REGION).send(command);
    return true;
  } catch {
    return false;
  }
}
