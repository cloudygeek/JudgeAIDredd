import { query } from "@anthropic-ai/claude-agent-sdk";

const env = {
  ...process.env,
  CLAUDE_CODE_USE_BEDROCK: "1",
  AWS_REGION: "eu-west-2",
};

const stream = query({
  prompt: "say hi in 3 words",
  options: {
    model: "eu.anthropic.claude-sonnet-4-6",
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    env,
  },
});
for await (const m of stream) {
  console.log(m.type, JSON.stringify(m).substring(0, 200));
}
