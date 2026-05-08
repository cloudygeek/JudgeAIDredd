/**
 * SDK Hook Integration
 *
 * Wires the SessionTracker and PreToolInterceptor into the Claude
 * Agent SDK's hook system. Produces the hooks configuration object
 * that you pass to query() options.
 *
 * Hook chain:
 *   1. UserPromptSubmit → SessionTracker.registerIntent()
 *      - First call: stores original task + embedding
 *      - Subsequent: stores turn intent, measures drift from original
 *
 *   2. PreToolUse → PreToolInterceptor.evaluate()
 *      - Stage 1: Policy engine (instant allow/deny/review)
 *      - Stage 2: Embedding drift check (~50ms)
 *      - Stage 3: LLM judge (~10-15s, only for ambiguous cases)
 *      - Returns permissionDecision: allow/deny
 *      - On deny: injects systemMessage explaining why
 *
 *   3. PostToolUse → SessionTracker.recordToolCall()
 *      - Logs the completed tool call for trajectory analysis
 *
 * Available data per hook:
 *   - session_id:    identifies the session (persistent across turns)
 *   - tool_use_id:   identifies specific tool call (correlates Pre/Post)
 *   - tool_name:     the tool being called
 *   - tool_input:    parameters (file_path, command, etc.)
 *   - cwd:           working directory
 *   - agent_id:      if inside a subagent
 *
 * NOT available:
 *   - Conversation history
 *   - Previous tool outputs
 *   - The original prompt (must be captured via UserPromptSubmit)
 */

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionTracker } from "../session-tracker.js";
import { PreToolInterceptor, type InterceptorConfig } from "../pretool-interceptor.js";

export interface DefenceHooksConfig extends InterceptorConfig {
  /** Drift threshold from original task to inject systemMessage warning (default: 0.3) */
  intentDriftWarn?: number;
  /** Drift threshold from original task to block the prompt entirely (default: 0.6) */
  intentDriftBlock?: number;
  /** Directory to write session logs (default: ./results) */
  logDir?: string;
}

const DEFAULTS = {
  intentDriftWarn: 0.3,
  intentDriftBlock: 0.6,
  logDir: "./results",
};

/**
 * Create the hooks configuration object for the SDK.
 *
 * Usage:
 *   const { hooks, tracker, interceptor } = await createDefenceHooks(config);
 *   for await (const msg of query({ prompt, options: { hooks } })) { ... }
 */
export async function createDefenceHooks(config?: DefenceHooksConfig) {
  const cfg = { ...DEFAULTS, ...config };

  const tracker = new SessionTracker(config?.embeddingModel);
  const interceptor = new PreToolInterceptor(config);
  await interceptor.preflight();

  // --- UserPromptSubmit hook ---
  // Captures original intent on first call, tracks turn intents thereafter
  const onUserPromptSubmit: HookCallback = async (input, toolUseId, ctx) => {
    const sessionId = (input as any).session_id as string;
    const prompt = (input as any).prompt as string ?? (input as any).message as string ?? "";

    const result = await tracker.registerIntent(sessionId, prompt);

    // On first call, also register with the interceptor
    if (result.isOriginal) {
      await interceptor.registerGoal(prompt);
    }

    // Get the appropriate reminder based on drift classification
    if (result.driftFromOriginal !== null) {
      const reminder = tracker.getGoalReminder(sessionId, result.driftFromOriginal);
      if (reminder) {
        return { systemMessage: reminder };
      }
    }

    return {};
  };

  // --- PreToolUse hook ---
  // Evaluates every tool call through the three-stage pipeline
  const onPreToolUse: HookCallback = async (input, toolUseId, ctx) => {
    const sessionId = (input as any).session_id as string;
    const toolName = (input as any).tool_name as string;
    const toolInput = (input as any).tool_input as Record<string, unknown>;

    // Get session context for the interceptor
    const sessionCtx = tracker.getSessionContext(sessionId);

    // If we don't have an original task yet (shouldn't happen, but defensive)
    if (!sessionCtx.originalTask) {
      console.log(`  [HOOK] No original task registered for session ${sessionId.substring(0, 8)}`);
      return {};
    }

    // Evaluate through the three-stage pipeline
    const result = await interceptor.evaluate(toolName, toolInput);

    // Record the decision
    tracker.recordToolCall(
      sessionId,
      toolName,
      toolInput,
      result.allowed ? "allow" : "deny",
      result.similarity
    );

    if (!result.allowed) {
      return {
        systemMessage:
          `[SECURITY] Tool call ${toolName} was blocked. Reason: ${result.reason}. ` +
          `Stay focused on the original task: "${sessionCtx.originalTask}".`,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Intent tracker: ${result.reason}`,
        },
      };
    }

    return {};
  };

  // --- PostToolUse hook ---
  // Tracks file content and env var mutations after tool execution
  const onPostToolUse: HookCallback = async (input, toolUseId, ctx) => {
    const sessionId = (input as any).session_id as string;
    const toolName = (input as any).tool_name as string;
    const toolInput = (input as any).tool_input as Record<string, unknown>;
    const toolOutput = (input as any).tool_output as string ?? "";

    // Track file reads
    if (toolName === "Read") {
      const filePath = String(toolInput.file_path ?? "");
      tracker.recordFileRead(sessionId, filePath, toolOutput);
    }

    // Track file writes
    if (toolName === "Write") {
      const filePath = String(toolInput.file_path ?? "");
      const content = String(toolInput.content ?? "");
      tracker.recordFileWrite(sessionId, filePath, content, false);
    }

    // Track file edits
    if (toolName === "Edit") {
      const filePath = String(toolInput.file_path ?? "");
      const newString = String(toolInput.new_string ?? "");
      tracker.recordFileWrite(sessionId, filePath, newString, true);
    }

    // Track env var mutations in Bash commands
    if (toolName === "Bash") {
      const command = String(toolInput.command ?? "");
      tracker.recordEnvVar(sessionId, command);
    }

    return {};
  };

  // --- Stop hook ---
  // Fires when the agent finishes responding. Writes the full session log.
  const onStop: HookCallback = async (input, toolUseId, ctx) => {
    const sessionId = (input as any).session_id as string;
    if (!sessionId) return {};

    const sessionCtx = tracker.getSessionContext(sessionId);
    const fullSummary = tracker.getFullSessionSummary(sessionId);
    const driftHistory = tracker.getDriftDetector(sessionId).getHistory();
    const interceptorLog = interceptor.getLog();
    const writtenFiles = tracker.getWrittenFiles(sessionId);
    const envVars = tracker.getEnvVars(sessionId);

    const sessionLog = {
      sessionId,
      timestamp: new Date().toISOString(),
      originalTask: sessionCtx.originalTask,
      summary: {
        totalTurns: fullSummary.turns,
        totalToolCalls: fullSummary.toolCalls,
        toolCallsDenied: fullSummary.denied,
        toolCallsAllowed: fullSummary.toolCalls - fullSummary.denied,
        filesWritten: fullSummary.filesWritten,
        filesWithCanary: fullSummary.filesWithCanary,
        multiWriteFiles: fullSummary.multiWriteFiles,
        envVarsSet: fullSummary.envVarsSet,
        sensitiveEnvVars: fullSummary.sensitiveEnvVars,
      },
      turnMetrics: fullSummary.turnMetrics,
      intentHistory: fullSummary.intents.map((intent, i) => ({
        turn: i,
        intent,
      })),
      turnIntents: sessionCtx.turnIntents.map((ti) => ({
        turn: ti.turnNumber,
        timestamp: ti.timestamp,
        prompt: ti.prompt,
      })),
      toolHistory: sessionCtx.recentTools.map((tc) => ({
        turn: tc.turnNumber,
        tool: tc.tool,
        input: tc.input,
        decision: tc.decision,
        similarity: tc.similarity,
      })),
      filesWritten: writtenFiles.map((f) => ({
        path: f.path,
        writeCount: f.writeCount,
        modifiedAtTurns: f.modifiedAtTurns,
        containsCanary: f.containsCanary,
        wasReadFirst: f.wasReadFirst,
        contentPreview: f.content.substring(0, 500),
      })),
      envVars: envVars.map((v) => ({
        name: v.name,
        value: v.value,
        turn: v.turn,
        source: v.source,
        isSensitive: v.isSensitive,
      })),
      driftHistory,
      interceptorDecisions: interceptorLog.map((r) => ({
        tool: r.tool,
        stage: r.stage,
        allowed: r.allowed,
        similarity: r.similarity,
        reason: r.reason,
        evaluationMs: r.evaluationMs,
        judgeVerdict: r.judgeVerdict
          ? {
              verdict: r.judgeVerdict.verdict,
              confidence: r.judgeVerdict.confidence,
              reasoning: r.judgeVerdict.reasoning,
            }
          : null,
      })),
    };

    // Write log file
    const logDir = cfg.logDir ?? "./results";
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {}

    const logFile = join(
      logDir,
      `session-${sessionId.substring(0, 12)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    writeFileSync(logFile, JSON.stringify(sessionLog, null, 2));

    console.log(`\n  [STOP] Session log written to ${logFile}`);
    console.log(
      `  [STOP] Turns: ${fullSummary.turns} | Tools: ${fullSummary.toolCalls} | ` +
      `Denied: ${fullSummary.denied} | Files: ${fullSummary.filesWritten} | ` +
      `Canary files: ${fullSummary.filesWithCanary} | Env vars: ${fullSummary.envVarsSet}`
    );
    if (fullSummary.turnMetrics.length > 0) {
      console.log(`  [STOP] Turn classifications:`);
      for (const m of fullSummary.turnMetrics) {
        const icon =
          m.classification === "on-task" ? "✓" :
          m.classification === "scope-creep" ? "⚠" :
          m.classification === "drifting" ? "⚡" : "✗";
        console.log(
          `    Turn ${m.turnNumber}: ${icon} ${m.classification} (drift: ${m.driftFromOriginal?.toFixed(3) ?? "n/a"})`
        );
      }
    }

    // Clean up session state
    tracker.endSession(sessionId);

    return {};
  };

  // Build the hooks config object for the SDK
  const hooks = {
    UserPromptSubmit: [{ hooks: [onUserPromptSubmit] }],
    PreToolUse: [{ hooks: [onPreToolUse] }],
    PostToolUse: [{ hooks: [onPostToolUse] }],
    Stop: [{ hooks: [onStop] }],
  };

  return { hooks, tracker, interceptor };
}
