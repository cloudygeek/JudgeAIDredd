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
import { recordBedrockCall } from "./bedrock-metrics.js";
import { createHash } from "node:crypto";
import type { BedrockAuth } from "./byot/types.js";

const REGION = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "eu-central-1";
const MODEL_ID = process.env.BEDROCK_JUDGE_MODEL ?? "nvidia.nemotron-super-3-120b";

// One-shot cache diagnostic counter. Logs the cache-engagement state
// for the first N bedrockChat calls of a process so we can diagnose
// whether prompt caching is actually firing without redeploying. Kept
// small to avoid spamming CloudWatch — after the threshold normal log
// lines (via pretool-interceptor judge line) carry the same info.
const CACHE_DIAGNOSTIC_LIMIT = 10;
let firstCacheCallsLogged = 0;

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "none";

export interface BedrockImageBlock {
  /** Base64-encoded image data */
  data: string;
  /** MIME type, e.g. "image/png" */
  mediaType: string;
}

// Bounded per-credential client cache. Keyed by `${region}#${authFp}` so
// the platform role and each distinct bearer token get their own client.
// LRU-evicted (delete + reinsert on touch; drop oldest past the cap) so a
// burst of distinct BYOT users can't grow the map without limit.
const MAX_CLIENTS = 200;
const clients = new Map<string, BedrockRuntimeClient>();

function authFingerprint(auth?: BedrockAuth): string {
  if (!auth || auth.kind === "default") return "default";
  // kind === "bearer"
  return "bearer:" + createHash("sha256").update(auth.token).digest("hex").slice(0, 16);
}

/** Region a call should use: a bearer token is bound to its own region;
 *  default creds use the module REGION. */
function regionFor(auth?: BedrockAuth, fallback = REGION): string {
  return auth && auth.kind === "bearer" ? auth.region : fallback;
}

function clientFor(region: string, auth?: BedrockAuth): BedrockRuntimeClient {
  const key = `${region}#${authFingerprint(auth)}`;
  const existing = clients.get(key);
  if (existing) {
    clients.delete(key); clients.set(key, existing); // LRU touch
    return existing;
  }
  let client: BedrockRuntimeClient;
  if (auth && auth.kind === "bearer") {
    // Per-client bearer auth. The bedrock-runtime auth scheme provider
    // lists sigv4 BEFORE bearer for every operation, so setting `token`
    // alone is not enough — platform IAM creds in the chain would win.
    // authSchemePreference forces bearer for this client only. (The
    // process-wide AWS_BEARER_TOKEN_BEDROCK env var is NOT multi-tenant
    // safe, which is why this is per-client config.)
    client = new BedrockRuntimeClient({
      region,
      token: { token: auth.token },
      authSchemePreference: ["httpBearerAuth"],
    });
  } else {
    client = new BedrockRuntimeClient({ region });
  }
  if (clients.size >= MAX_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest !== undefined) clients.delete(oldest);
  }
  clients.set(key, client);
  return client;
}

/** Test-only accessor for the client cache keying. */
export function __clientForTest(region: string, auth?: BedrockAuth): BedrockRuntimeClient {
  return clientFor(region, auth);
}

/** Errors that mean "this credential can't make this call" — retry on the
 *  platform role. Throttling/unavailable included per the BYOT fail-soft
 *  decision (keep the judge running on the platform if the user's account
 *  is throttled). Anything else (e.g. a genuine ValidationException from a
 *  malformed request) propagates unchanged. */
const BYOT_FALLBACK_ERRORS = new Set([
  "AccessDeniedException",
  "UnauthorizedException",
  "UnrecognizedClientException",
  "ExpiredTokenException",
  "InvalidSignatureException",
  "ThrottlingException",
  "ThrottledException",
  "ServiceUnavailableException",
  "ServiceQuotaExceededException",
]);
function isByotFallbackError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return BYOT_FALLBACK_ERRORS.has(name);
}

/** Optional tag identifying which call site is invoking Bedrock. Used
 *  by `bedrock-metrics.ts` to attribute per-caller cost and cache
 *  performance. Unknown values fall through to "unknown" so a forgotten
 *  call site still shows up in the snapshot. */
export type BedrockCaller = "judge" | "classifier" | "promptarmor" | "preflight" | "unknown";

export async function bedrockChat(
  systemPrompt: string,
  userMessage: string,
  modelId = MODEL_ID,
  effort?: EffortLevel,
  images?: BedrockImageBlock[],
  caller: BedrockCaller = "unknown",
  auth?: BedrockAuth,
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
  /** Set when a bearer call failed on an auth/throttle error and we
   *  retried on the platform role. Undefined on the happy path. */
  byotFallback?: { reason: string };
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
  // hardened system prompt is billed at 10% of the input rate for the
  // next 5 minutes (cache TTL). The cache key is "everything before
  // this marker"; the per-call user message after it is billed normally.
  //
  // We do NOT mark a cache point inside the user content because that
  // changes per call (tool input, file context, agent reasoning) —
  // caching it would invalidate every time. The system prompt is the
  // static 90%+ of every judge request.
  //
  // KNOWN ISSUE (deferred — see CLAUDE.md "Cost & cache-engagement notes"):
  // On `eu.anthropic.claude-sonnet-4-6` the empirical cache-engagement
  // threshold is ~2048 tokens, not the documented 1024. Our B7.1 system
  // prompt is ~1766 tokens — under the real threshold — so this marker
  // is silently a no-op in prod today. Fix when we scale: pad the
  // system prompt to >2048 tokens with static content.
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

  // Hard timeout on the Bedrock call — a stuck request previously
  // hung the event loop indefinitely (CloudWatch outage on
  // 2026-05-10T03:17 to 07:32 UTC: hook went silent after a single
  // /screen call never returned, ALB health-check took 2h 23m to
  // notice). 120s is generous — opus thinking-mode runs can take
  // 30-60s. Anything longer is a hung connection, not a slow model.
  // Override via BEDROCK_REQUEST_TIMEOUT_MS for thinking-mode runs
  // that legitimately need more headroom.
  const timeoutMs = parseInt(process.env.BEDROCK_REQUEST_TIMEOUT_MS ?? "120000", 10);

  // Per-attempt fresh abort signal (a reused timeout could be near-expired
  // on the retry). Bearer auth → user's region; default → module REGION.
  const sendWith = (a?: BedrockAuth) =>
    clientFor(regionFor(a), a).send(command, { abortSignal: AbortSignal.timeout(timeoutMs) });

  let response;
  let byotFallback: { reason: string } | undefined;
  try {
    response = await sendWith(auth);
  } catch (err) {
    if (auth && auth.kind === "bearer" && !auth.noFallback && isByotFallbackError(err)) {
      byotFallback = { reason: (err as { name?: string })?.name ?? "byot-error" };
      console.warn(`  [bedrock] BYOT ${caller} call failed (${byotFallback.reason}); falling back to platform creds`);
      response = await sendWith({ kind: "default" });
    } else {
      throw err;
    }
  }

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
  const durationMs = Date.now() - start;
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? undefined;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? undefined;

  // Cache-engagement diagnostic. The cachePoint marker above SHOULD
  // cause Bedrock to return non-zero cacheRead or cacheWrite once the
  // 1024-token minimum is met. If we see neither after several judge
  // calls, that's a signal the cache isn't engaging — either the
  // system prompt is below the per-model minimum, the cross-region
  // inference profile doesn't honor the marker, or the model ID we
  // passed isn't in the cache-supported list. Log the first few calls
  // per process so we can diagnose without redeploying.
  try {
    if (firstCacheCallsLogged < CACHE_DIAGNOSTIC_LIMIT) {
      firstCacheCallsLogged++;
      console.log(
        `[bedrock-cache] caller=${caller} model=${modelId} ` +
        `systemChars=${systemPrompt.length} ` +
        `inputTokens=${inputTokens} outputTokens=${outputTokens} ` +
        `cacheRead=${cacheReadInputTokens ?? "n/a"} ` +
        `cacheWrite=${cacheWriteInputTokens ?? "n/a"} ` +
        `usageKeys=[${Object.keys(usage).join(",")}]`,
      );
    }
  } catch { /* diagnostic must not fail the request */ }

  // Cost accounting. Fire-and-forget — accumulator is in-process and
  // never throws. Failure here must not break the judge / classifier.
  try {
    recordBedrockCall(caller, {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
      durationMs,
    });
  } catch { /* metrics never fail the request */ }

  return {
    content,
    thinking,
    durationMs,
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? (inputTokens + outputTokens),
    cacheReadInputTokens,
    cacheWriteInputTokens,
    hasThinkingBlock,
    estimatedThinkingTokens: thinking ? Math.ceil(thinking.length / 4) : 0,
    byotFallback,
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
    // Short timeout on the preflight: 30s is plenty for a 1-token
    // sanity call. Don't let preflight hang container startup.
    await clientFor(REGION).send(command, { abortSignal: AbortSignal.timeout(30_000) });
    return true;
  } catch {
    return false;
  }
}
