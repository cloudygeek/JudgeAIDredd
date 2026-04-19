/**
 * Bedrock Client
 *
 * Calls Nemotron-3-Super via Amazon Bedrock's Converse API.
 * Uses default AWS credentials from the environment.
 * Writes request to temp file to avoid shell escaping issues.
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REGION = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "eu-central-1";
const MODEL_ID = process.env.BEDROCK_JUDGE_MODEL ?? "nvidia.nemotron-super-3-120b";

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "none";

export interface BedrockImageBlock {
  /** Base64-encoded image data */
  data: string;
  /** MIME type, e.g. "image/png" */
  mediaType: string;
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

  // Write request components to temp files to avoid shell escaping
  const tmpMessages = join(tmpdir(), `bedrock-msg-${Date.now()}.json`);
  const tmpSystem = join(tmpdir(), `bedrock-sys-${Date.now()}.json`);
  const tmpConfig = join(tmpdir(), `bedrock-cfg-${Date.now()}.json`);
  let tmpThinking: string | null = null;

  try {
    const userContent: Record<string, unknown>[] = [{ text: userMessage }];
    if (images?.length) {
      for (const img of images) {
        const format = img.mediaType.replace("image/", "");
        userContent.push({
          image: { format, source: { bytes: img.data } },
        });
      }
    }
    writeFileSync(tmpMessages, JSON.stringify([
      {
        role: "user",
        content: userContent,
      },
    ]));

    writeFileSync(tmpSystem, JSON.stringify([
      { text: systemPrompt },
    ]));

    const budgetMap: Record<string, number> = { low: 1024, medium: 5000, high: 16000, max: 60000 };
    const budgetTokens = budgetMap[effort!] ?? 5000;
    const isOpus47 = modelId.includes("opus-4-7");
    const inferenceConfig: Record<string, unknown> = {
      maxTokens: effort ? (isOpus47 ? 16384 : Math.min(budgetTokens + 4096, 64000)) : 512,
    };
    if (!isOpus47) inferenceConfig.temperature = effort ? 1 : 0.1;
    writeFileSync(tmpConfig, JSON.stringify(inferenceConfig));

    const cmdParts = [
      "aws", "bedrock-runtime", "converse",
      "--region", REGION,
      "--model-id", modelId,
      "--messages", `file://${tmpMessages}`,
      "--system", `file://${tmpSystem}`,
      "--inference-config", `file://${tmpConfig}`,
      "--output", "json",
    ];

    if (effort) {
      tmpThinking = join(tmpdir(), `bedrock-think-${Date.now()}.json`);
      const thinkingFields = isOpus47
        ? { thinking: { type: "adaptive" }, output_config: { effort } }
        : { thinking: { type: "enabled", budget_tokens: budgetTokens } };
      writeFileSync(tmpThinking, JSON.stringify(thinkingFields));
      cmdParts.push("--additional-model-request-fields", `file://${tmpThinking}`);
    }

    const cmd = cmdParts.join(" ");

    const result = execSync(cmd, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 120000,
    });

    const parsed = JSON.parse(result);
    const blocks = parsed.output.message.content as Record<string, unknown>[];
    const content = blocks
      .filter((c) => c.text !== undefined)
      .map((c) => c.text as string)
      .join("");
    const thinking = blocks
      .filter((c) => c.reasoningContent !== undefined)
      .map((c) => {
        const rc = c.reasoningContent as Record<string, unknown>;
        const rt = rc.reasoningText as Record<string, unknown> | undefined;
        return ((rt?.text ?? rc.text ?? "") as string);
      })
      .join("");

    const usage = parsed.usage ?? {};
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
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      hasThinkingBlock,
      estimatedThinkingTokens: thinking ? Math.ceil(thinking.length / 4) : 0,
    };
  } finally {
    try { unlinkSync(tmpMessages); } catch {}
    try { unlinkSync(tmpSystem); } catch {}
    try { unlinkSync(tmpConfig); } catch {}
    if (tmpThinking) try { unlinkSync(tmpThinking); } catch {}
  }
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

function invokeModel(modelId: string, body: object, region: string): object {
  const tmpIn  = join(tmpdir(), `bedrock-embed-in-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const tmpOut = join(tmpdir(), `bedrock-embed-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    writeFileSync(tmpIn, JSON.stringify(body));
    const cmd = [
      "aws", "bedrock-runtime", "invoke-model",
      "--region", region,
      "--model-id", modelId,
      "--body", `file://${tmpIn}`,
      "--cli-binary-format", "raw-in-base64-out",
      tmpOut,
    ].join(" ");
    execSync(cmd, { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(readFileSync(tmpOut, "utf8"));
  } finally {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}

function cohereEmbed(texts: string[], modelId: string, region: string): number[][] {
  const resp = invokeModel(modelId, { texts, input_type: "search_query" }, region) as Record<string, unknown>;
  // v3: { embeddings: number[][] }
  // v4: { embeddings: { float: number[][] } }
  const emb = resp.embeddings as number[][] | { float: number[][] };
  return Array.isArray(emb) ? emb : emb.float;
}

function titanEmbed(text: string, modelId: string, region: string): number[] {
  const resp = invokeModel(modelId, { inputText: text }, region) as { embedding: number[] };
  return resp.embedding;
}

function marengoEmbed(text: string, modelId: string, region: string): number[] {
  // Marengo 3.0: { inputType: "text", text: { text: "..." } }
  // Marengo 2.7: { inputText: "..." }  (Titan-compatible schema)
  const bare = modelId.replace(/^(?:eu|us|global)\./, "");
  const body = bare.includes("marengo-embed-2-7")
    ? { inputType: "text", inputText: text }
    : { inputType: "text", text: { inputText: text } };

  const resp = invokeModel(modelId, body, region) as Record<string, unknown>;
  if (Array.isArray(resp.embedding)) return resp.embedding as number[];
  const data = resp.data as { embedding: number[] }[] | undefined;
  if (data?.[0]?.embedding) return data[0].embedding;
  throw new Error(`Unexpected Marengo response shape: ${JSON.stringify(resp).substring(0, 200)}`);
}

export async function checkBedrock(modelId = MODEL_ID): Promise<boolean> {
  // Test with a real converse call — avoids needing metadata API permissions
  // (bedrock:ListInferenceProfiles, bedrock:GetFoundationModel).
  try {
    execSync(
      `aws bedrock-runtime converse --region ${REGION} --model-id "${modelId}" --messages '[{"role":"user","content":[{"text":"ok"}]}]' --inference-config '{"maxTokens":1}' --output text --query "output.message.content[0].text" 2>/dev/null`,
      { encoding: "utf8", timeout: 15000 }
    );
    return true;
  } catch {
    return false;
  }
}
