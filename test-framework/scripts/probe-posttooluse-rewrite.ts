/**
 * T-0 SDK probe — does the PostToolUse hook's `updatedMCPToolOutput`
 * rewrite the output of BUILT-IN tools (Read/Bash/Glob/etc.) too, or
 * is it strictly MCP-tool-only?
 *
 * This is the gating question for `docs/plan-promptarmor-test-framework-2026-05-13.md`:
 *   - If built-in tools ARE rewritten: Path A (clean integration, ~8.5h)
 *   - If only MCP tools: Path C (observational PromptArmor, ~7h with caveat)
 *
 * HOW TO RUN
 * ----------
 *   cd /Users/adrian/IdeaProjects/JudgeAIDredd/test-framework
 *   npm install        # first time only; ~1 min
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/probe-posttooluse-rewrite.ts
 *
 * The probe prints a single verdict line at the end:
 *   PROBE RESULT: path-a   → built-in tools are rewritten ✅
 *   PROBE RESULT: path-c   → built-in tools NOT rewritten (sentinel never seen) ⚠️
 *   PROBE RESULT: mixed    → agent saw both original + sentinel
 *   PROBE RESULT: error    → SDK threw on the hook return shape
 *
 * The probe runs against `claude-sonnet-4-6` (cheap, ~1 tool call,
 * ~1500 input tokens, ~$0.01 total).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Sentinels chosen so they cannot collide with file content or normal prose ---
const REAL_CONTENT_SENTINEL = "BANANA_REAL_CONTENT_4F8A2C";
const REWRITE_SENTINEL = "QWERTY_REWRITTEN_BY_HOOK_9X3K1P";

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "p15-probe-"));
  const filePath = join(workDir, "secret.txt");
  const realContent = `This file's secret password is ${REAL_CONTENT_SENTINEL}. Treat it as sensitive.`;
  writeFileSync(filePath, realContent, "utf8");

  console.log("─".repeat(70));
  console.log("PROBE: PostToolUse.updatedMCPToolOutput on built-in tools");
  console.log("─".repeat(70));
  console.log(`workspace:        ${workDir}`);
  console.log(`real content has: ${REAL_CONTENT_SENTINEL}`);
  console.log(`rewrite sets:     ${REWRITE_SENTINEL}`);
  console.log("─".repeat(70));

  let hookCalled = false;
  let hookErrored: string | null = null;
  let toolNameSeen: string | null = null;

  const postToolUseHook = async (input: any, _toolUseId: any, _ctx: any) => {
    hookCalled = true;
    toolNameSeen = input.tool_name ?? "(unknown)";
    const orig = typeof input.tool_response === "string"
      ? input.tool_response.substring(0, 80)
      : JSON.stringify(input.tool_response).substring(0, 80);
    console.log(`  [hook] PostToolUse fired: tool=${toolNameSeen}  raw=${orig}…`);
    try {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedMCPToolOutput: `REWRITTEN BY POSTTOOLUSE HOOK. The file actually contains: ${REWRITE_SENTINEL}. (Real content suppressed.)`,
        },
      };
    } catch (err) {
      hookErrored = err instanceof Error ? err.message : String(err);
      console.log(`  [hook] ERROR returning rewrite: ${hookErrored}`);
      return {};
    }
  };

  let agentText = "";
  let sdkError: string | null = null;

  // Bedrock-routed Claude Code SDK. The SDK shells out to the `claude`
  // CLI; that CLI reads CLAUDE_CODE_USE_BEDROCK to know whether to call
  // api.anthropic.com (default) or AWS Bedrock. The SDK forwards
  // options.env to the subprocess but doesn't merge process.env, so we
  // build the full env explicitly here. Direct API also works if you
  // unset CLAUDE_CODE_USE_BEDROCK and set ANTHROPIC_API_KEY.
  const useBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === "1";
  const subprocessEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_OPTIONS: "--max-old-space-size=4096",
  };

  try {
    const stream = query({
      prompt: `Read the file secret.txt in this directory and tell me, in one sentence, what the secret password is.`,
      options: {
        model: useBedrock ? "eu.anthropic.claude-sonnet-4-6" : "claude-sonnet-4-6",
        allowedTools: ["Read"],
        permissionMode: "bypassPermissions",
        maxTurns: 8,
        cwd: workDir,
        env: subprocessEnv,
        hooks: {
          PostToolUse: [{ hooks: [postToolUseHook] }],
        },
      } as any,
    });

    for await (const message of stream) {
      const m = message as any;
      if (m.type === "assistant") {
        const content = m.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text") agentText += block.text;
        }
      }
      if (m.type === "result") {
        if (m.result) agentText += m.result;
      }
    }
  } catch (err) {
    sdkError = err instanceof Error ? err.message : String(err);
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }

  console.log("─".repeat(70));
  console.log("agent's final text (truncated to 300 chars):");
  console.log(agentText.substring(0, 300));
  console.log("─".repeat(70));

  // --- Verdict ---
  const sawReal = agentText.includes(REAL_CONTENT_SENTINEL);
  const sawRewrite = agentText.includes(REWRITE_SENTINEL);
  let verdict: "path-a" | "path-c" | "mixed" | "error";
  if (sdkError) {
    verdict = "error";
  } else if (sawRewrite && !sawReal) {
    verdict = "path-a";
  } else if (!sawRewrite && sawReal) {
    verdict = "path-c";
  } else if (sawRewrite && sawReal) {
    verdict = "mixed";
  } else {
    verdict = "error";
  }

  console.log(`hook called:       ${hookCalled}`);
  console.log(`tool name seen:    ${toolNameSeen ?? "(none — hook never fired)"}`);
  console.log(`agent saw REAL:    ${sawReal}`);
  console.log(`agent saw REWRITE: ${sawRewrite}`);
  if (sdkError) console.log(`SDK error:         ${sdkError}`);
  if (hookErrored) console.log(`hook error:        ${hookErrored}`);
  console.log("");
  console.log(`PROBE RESULT: ${verdict}`);
  switch (verdict) {
    case "path-a":
      console.log("  → built-in tools ARE rewritten by PostToolUse hook.");
      console.log("  → Implement promptarmor-defence.ts on Path A (clean, ~8.5h).");
      break;
    case "path-c":
      console.log("  → built-in tools are NOT rewritten (sentinel never reached agent).");
      console.log("  → Fall back to Path C: observational PromptArmor (~7h + caveat).");
      break;
    case "mixed":
      console.log("  → Agent saw BOTH original and rewrite. Hook appends rather than replaces.");
      console.log("  → Treat as Path C; intervention isn't clean.");
      break;
    case "error":
      console.log("  → Indeterminate. Check logs above.");
      break;
  }
  console.log("");
}

main().catch((err) => {
  console.error("PROBE: top-level error:", err);
  process.exit(1);
});
