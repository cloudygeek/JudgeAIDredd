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

const REGION = process.env.AWS_REGION ?? "eu-central-1";
const MODEL_ID = process.env.BEDROCK_JUDGE_MODEL ?? "nvidia.nemotron-super-3-120b";

export async function bedrockChat(
  systemPrompt: string,
  userMessage: string,
  modelId = MODEL_ID
): Promise<{ content: string; durationMs: number; inputTokens: number; outputTokens: number }> {
  const start = Date.now();

  // Write request components to temp files to avoid shell escaping
  const tmpMessages = join(tmpdir(), `bedrock-msg-${Date.now()}.json`);
  const tmpSystem = join(tmpdir(), `bedrock-sys-${Date.now()}.json`);
  const tmpConfig = join(tmpdir(), `bedrock-cfg-${Date.now()}.json`);

  try {
    writeFileSync(tmpMessages, JSON.stringify([
      {
        role: "user",
        content: [{ text: userMessage }],
      },
    ]));

    writeFileSync(tmpSystem, JSON.stringify([
      { text: systemPrompt },
    ]));

    writeFileSync(tmpConfig, JSON.stringify({
      maxTokens: 256,
      temperature: 0.1,
    }));

    const cmd = [
      "aws", "bedrock-runtime", "converse",
      "--region", REGION,
      "--model-id", modelId,
      "--messages", `file://${tmpMessages}`,
      "--system", `file://${tmpSystem}`,
      "--inference-config", `file://${tmpConfig}`,
      "--output", "json",
    ].join(" ");

    const result = execSync(cmd, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 120000,
    });

    const parsed = JSON.parse(result);
    const content = parsed.output.message.content
      .map((c: { text: string }) => c.text)
      .join("");

    return {
      content,
      durationMs: Date.now() - start,
      inputTokens: parsed.usage?.inputTokens ?? 0,
      outputTokens: parsed.usage?.outputTokens ?? 0,
    };
  } finally {
    try { unlinkSync(tmpMessages); } catch {}
    try { unlinkSync(tmpSystem); } catch {}
    try { unlinkSync(tmpConfig); } catch {}
  }
}

export async function checkBedrock(modelId = MODEL_ID): Promise<boolean> {
  try {
    execSync(
      `aws bedrock get-foundation-model --region ${REGION} --model-identifier ${modelId} --query modelDetails.modelId --output text 2>/dev/null`,
      { encoding: "utf8", timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
}
