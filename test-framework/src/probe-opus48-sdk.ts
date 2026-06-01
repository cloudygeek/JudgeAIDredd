/**
 * Minimal probe: invoke the Claude Agent SDK directly against opus-4-8 with
 * exactly the queryOptions shape runner-mode4.ts uses, and print the actual
 * error if any. The runner buries errors in turn text; this one surfaces them.
 *
 * Usage:
 *   AWS_REGION=eu-central-1 CLAUDE_CODE_USE_BEDROCK=1 \
 *     tsx test-framework/src/probe-opus48-sdk.ts <model-id>
 *   model-id defaults to eu.anthropic.claude-opus-4-8
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";

const model = process.argv[2] ?? "eu.anthropic.claude-opus-4-8";
const sdkPkg = JSON.parse(readFileSync("./node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8"));
console.log(`[probe] SDK version:`, sdkPkg.version);
console.log(`[probe] model:`, model);
console.log(`[probe] AWS_REGION=${process.env.AWS_REGION} CLAUDE_CODE_USE_BEDROCK=${process.env.CLAUDE_CODE_USE_BEDROCK}`);

const queryOptions: Record<string, unknown> = {
  allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  permissionMode: "bypassPermissions",
  maxTurns: 2,
  cwd: process.cwd(),
  model,
};

try {
  let count = 0;
  for await (const message of query({
    prompt: "Reply with exactly the word PONG and nothing else.",
    options: queryOptions as any,
  })) {
    count++;
    console.log(`[probe] message ${count}:`, JSON.stringify({
      type: (message as any).type,
      subtype: (message as any).subtype,
      result: typeof (message as any).result === "string" ? (message as any).result.substring(0, 200) : undefined,
      content_preview: (message as any).message?.content
        ?.map((b: any) => ({ type: b.type, text: b.text?.substring?.(0, 100) }))
        .slice(0, 3),
      is_error: (message as any).is_error,
      error: (message as any).error,
    }));
    if (count > 30) {
      console.log("[probe] message cap hit, stopping");
      break;
    }
  }
  console.log(`[probe] done, ${count} messages`);
} catch (err) {
  console.error(`[probe] CAUGHT ERROR:`);
  console.error(`  message: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  name: ${err instanceof Error ? err.name : "n/a"}`);
  console.error(`  stack: ${err instanceof Error ? err.stack : "n/a"}`);
  if (err && typeof err === "object" && "cause" in err) {
    console.error(`  cause: ${JSON.stringify((err as any).cause, null, 2).substring(0, 500)}`);
  }
}
