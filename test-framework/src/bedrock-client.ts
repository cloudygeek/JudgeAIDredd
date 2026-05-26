/**
 * Bedrock client for the test-framework's IntentTracker layer-1 (drift
 * detector embedding) and layer-2 (judge chat). Lets us run intent
 * tracker / drift-only / anchor-only defences in environments where
 * an Ollama daemon isn't available — such as the AI Sandbox Fargate
 * container.
 *
 * Two endpoints:
 *   - embed():       Cohere v4 via InvokeModel (model: cohere.embed-v4)
 *   - chat():        Anthropic via Converse (model: claude-sonnet-4-6)
 *
 * Region resolution: BEDROCK_REGION env > AWS_REGION env > eu-west-2.
 * AWS credentials come from the standard SDK chain (env, shared config,
 * IRSA, IMDSv2). The Fargate task role is the production path.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const REGION =
  process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "eu-west-2";

// 2026-05-26: bedt5 hung for 28h and bedt3 for 7h on a stalled
// Converse call — the SDK keeps a keep-alive socket pool with no
// default request/socket timeout, so a half-closed TCP socket
// becomes an unbounded await on the next reuse. Cap every layer:
//   - connectionTimeout: TCP connect must complete in 10s
//   - socketTimeout: idle reads on an in-flight body fail in 60s
//   - requestTimeout: total request can't exceed 5min
//   - SEND_TIMEOUT_MS (below): outer AbortSignal that also covers
//     the SDK's retry strategy (up to 3 attempts, otherwise 15min
//     worst-case before the requestTimeout * retries adds up)
const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 300_000;
export const SEND_TIMEOUT_MS = 360_000;

function makeRequestHandler(): NodeHttpHandler {
  return new NodeHttpHandler({
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });
}

function makeClient(region: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region,
    requestHandler: makeRequestHandler(),
  });
}

let client: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (!client) client = makeClient(REGION);
  return client;
}

/**
 * Run an SDK send() with a hard outer timeout, recycling the cached
 * shared client on failure so the next caller doesn't inherit a
 * poisoned keep-alive pool.
 */
async function sendWithTimeout<T>(
  c: BedrockRuntimeClient,
  cmd: any,
  isShared: boolean,
): Promise<T> {
  try {
    return (await c.send(cmd, {
      abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })) as T;
  } catch (err) {
    if (isShared) client = null;
    try {
      c.destroy();
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Generate an embedding via Bedrock InvokeModel. Defaults to Cohere v4
 * which the main hook already uses for drift detection.
 */
export async function bedrockEmbed(
  text: string,
  modelId = "eu.cohere.embed-v4:0",
): Promise<number[]> {
  const body = JSON.stringify({
    texts: [text],
    input_type: "search_document",
    embedding_types: ["float"],
  });
  const cmd = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: new TextEncoder().encode(body),
  });
  const resp = await sendWithTimeout<any>(getClient(), cmd, true);
  const decoded = JSON.parse(new TextDecoder().decode(resp.body));
  // Cohere v4 returns { embeddings: { float: number[][] } }; older
  // shape was { embeddings: number[][] }. Handle both.
  const embs = decoded?.embeddings?.float ?? decoded?.embeddings;
  if (!Array.isArray(embs) || !Array.isArray(embs[0])) {
    throw new Error(`Unexpected embedding response shape: ${JSON.stringify(decoded).slice(0, 200)}`);
  }
  return embs[0] as number[];
}

/**
 * Chat completion via Bedrock Converse. Used by the judge.
 */
export async function bedrockChat(
  systemPrompt: string,
  userMessage: string,
  modelId = "eu.anthropic.claude-sonnet-4-6",
): Promise<{ content: string; durationMs: number }> {
  const start = Date.now();
  const isOpus47 = modelId.includes("opus-4-7");
  const inferenceConfig: Record<string, unknown> = { maxTokens: 1024 };
  // Bedrock Converse rejects `temperature` for opus-4-7 (per memory note).
  if (!isOpus47) inferenceConfig.temperature = 0.1;

  const cmd = new ConverseCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages: [{ role: "user", content: [{ text: userMessage }] }],
    inferenceConfig,
  });
  const resp = await sendWithTimeout<any>(getClient(), cmd, true);
  const text =
    resp.output?.message?.content
      ?.map((b: any) => ("text" in b ? b.text : ""))
      .join("") ?? "";
  return { content: text, durationMs: Date.now() - start };
}

/**
 * Low-level Bedrock Converse passthrough — used by the AgentLAB
 * runner where the previous shape was `execSync("aws bedrock-runtime
 * converse ...")`. Returning the raw SDK response lets callers do
 * tool-use parsing themselves.
 *
 * Why this exists in addition to bedrockChat: the AgentLAB runner
 * sends a tool-config block and parses tool_use blocks from the
 * response; bedrockChat only flattens text. The two helpers share
 * the same client + region resolution.
 */
export async function bedrockConverse(args: {
  modelId: string;
  region?: string;
  messages: any[];
  system?: any[];
  inferenceConfig?: any;
  toolConfig?: any;
}): Promise<any> {
  const targetRegion = args.region ?? REGION;
  const isShared = targetRegion === REGION;
  const c = isShared ? getClient() : makeClient(targetRegion);
  const input: any = {
    modelId: args.modelId,
    messages: args.messages,
    inferenceConfig: args.inferenceConfig ?? { maxTokens: 1024 },
  };
  if (args.system) input.system = args.system;
  if (args.toolConfig) input.toolConfig = args.toolConfig;
  const resp = await sendWithTimeout<any>(
    c,
    new ConverseCommand(input),
    isShared,
  );
  // The aws-cli version returns a JSON-wire shape; the SDK returns
  // similar but uses Buffer for image bytes etc. Strip Buffers to
  // strings so consumers that do `JSON.parse(execSync(...))` style
  // walks of the response keep working.
  return JSON.parse(JSON.stringify(resp));
}

/**
 * Lightweight reachability probe — the constructor-time replacement
 * for checkOllama(). One short embed call confirms the SDK is wired
 * up and the IAM role can call Bedrock.
 */
export async function checkBedrock(
  embeddingModel: string,
  judgeModel: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await bedrockEmbed("preflight", embeddingModel);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
