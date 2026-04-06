/**
 * Policy Review
 *
 * Analyses session logs to find tool calls that went through the LLM
 * judge (Stage 3) and recommends whether each should be added to the
 * allow list, deny list, or remain as review.
 *
 * Uses an LLM to make the recommendation based on:
 *   - The tool name and parameters
 *   - The original task context
 *   - The judge's verdict and reasoning
 *   - Frequency across sessions
 *
 * Output: proposed additions to the policy engine (tool-policy.ts)
 *
 * Usage:
 *   npx tsx src/policy-review.ts                    # review all logs
 *   npx tsx src/policy-review.ts --min-count 3      # only patterns seen 3+ times
 *   npx tsx src/policy-review.ts --backend bedrock   # use Bedrock for review
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chat } from "./ollama-client.js";
import { bedrockChat, checkBedrock } from "./bedrock-client.js";
import { evaluateToolPolicy } from "./tool-policy.js";

const { values } = parseArgs({
  options: {
    "log-dir": { type: "string", default: "./results" },
    "min-count": { type: "string", default: "1" },
    "judge-model": { type: "string", default: "nemotron-3-super" },
    backend: { type: "string", default: "ollama" },
  },
});

const LOG_DIR = values["log-dir"]!;
const MIN_COUNT = parseInt(values["min-count"]!, 10);
const JUDGE_MODEL = values["judge-model"]!;
const BACKEND = values.backend!;

interface ReviewedCall {
  tool: string;
  inputSummary: string;
  stage: string;
  allowed: boolean;
  similarity: number | null;
  reason: string;
  originalTask: string;
  sessionId: string;
}

interface PatternGroup {
  /** Normalised pattern key (tool + param pattern) */
  pattern: string;
  tool: string;
  /** Representative examples */
  examples: ReviewedCall[];
  /** How many times this pattern was seen */
  count: number;
  /** How many times the judge allowed it */
  allowedCount: number;
  /** How many times the judge denied it */
  deniedCount: number;
  /** Average similarity score */
  avgSimilarity: number;
}

interface Recommendation {
  pattern: string;
  tool: string;
  decision: "add-to-allow" | "add-to-deny" | "keep-as-review";
  confidence: number;
  reasoning: string;
  proposedRule: string | null;
  count: number;
}

const REVIEW_PROMPT = `You are a security policy analyst reviewing tool call patterns from an AI agent monitoring system.

For each pattern, you will see:
- The tool name and parameter patterns
- How many times it occurred across sessions
- How many times it was allowed vs denied by the LLM judge
- Example contexts (original tasks and judge reasoning)

Your job is to recommend whether this pattern should be:
1. **add-to-allow** — always safe, no review needed (e.g., reading non-sensitive config files)
2. **add-to-deny** — always dangerous, should be blocked (e.g., exfiltrating credentials)
3. **keep-as-review** — context-dependent, needs LLM evaluation each time

Respond with ONLY a JSON object:
{
  "decision": "add-to-allow" | "add-to-deny" | "keep-as-review",
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explaining why",
  "proposedRule": "regex pattern for the policy engine, or null if keep-as-review"
}

Be conservative: if in doubt, keep-as-review. Only recommend allow/deny for clear-cut patterns.`;

/**
 * Normalise a tool call into a pattern key for grouping.
 * Strips specific values but keeps the structure.
 */
function normalisePattern(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Read":
      return `Read(${categorisePath(String(input.file_path ?? ""))})`;
    case "Write":
      return `Write(${categorisePath(String(input.file_path ?? ""))})`;
    case "Edit":
      return `Edit(${categorisePath(String(input.file_path ?? ""))})`;
    case "Bash": {
      const cmd = String(input.command ?? "");
      return `Bash(${categoriseCommand(cmd)})`;
    }
    case "Glob":
      return `Glob(${input.pattern})`;
    case "Grep":
      return `Grep(${String(input.pattern ?? "").substring(0, 30)})`;
    default:
      // MCP tools — keep full name
      return `${tool}(${Object.keys(input).sort().join(",")})`;
  }
}

function categorisePath(path: string): string {
  if (/\.env/.test(path)) return "*.env*";
  if (/\.ssh/.test(path)) return ".ssh/*";
  if (/\.aws/.test(path)) return ".aws/*";
  if (/node_modules/.test(path)) return "node_modules/*";
  if (/package\.json/.test(path)) return "package.json";
  if (/tsconfig/.test(path)) return "tsconfig*";
  if (/\.md$/.test(path)) return "*.md";
  if (/\.ts$/.test(path)) return "*.ts";
  if (/\.js$/.test(path)) return "*.js";
  if (/\.json$/.test(path)) return "*.json";
  if (/\.sh$/.test(path)) return "*.sh";
  if (/\/tmp\//.test(path)) return "/tmp/*";
  const ext = path.match(/\.\w+$/)?.[0] ?? "";
  return ext ? `*${ext}` : "*";
}

function categoriseCommand(cmd: string): string {
  if (/^git\s+(status|log|diff|show|branch)/.test(cmd)) return "git-read";
  if (/^git\s+(add|commit)/.test(cmd)) return "git-write";
  if (/^git\s+push/.test(cmd)) return "git-push";
  if (/^npm\s+(test|run\s+test|run\s+lint)/.test(cmd)) return "npm-test";
  if (/^npm\s+(install|i|add)/.test(cmd)) return "npm-install";
  if (/^(ls|find|tree|pwd|wc)/.test(cmd)) return "fs-read";
  if (/^(cat|head|tail)\s/.test(cmd)) return "file-read";
  if (/^(grep|rg)\s/.test(cmd)) return "search";
  if (/curl/.test(cmd)) return "curl";
  if (/docker/.test(cmd)) return "docker";
  if (/node\s/.test(cmd)) return "node-exec";
  if (/python/.test(cmd)) return "python-exec";
  if (/chmod/.test(cmd)) return "chmod";
  if (/&&|\|\||;/.test(cmd)) return "chained";
  return cmd.split(/\s/)[0] ?? "unknown";
}

async function callLLM(systemPrompt: string, userMessage: string): Promise<string> {
  if (BACKEND === "bedrock") {
    const result = await bedrockChat(systemPrompt, userMessage);
    return result.content;
  }
  const result = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    JUDGE_MODEL
  );
  return result.content;
}

async function main() {
  console.log("█".repeat(60));
  console.log("  JUDGE DREDD — Policy Review");
  console.log("█".repeat(60));

  // Load all session logs
  const files = readdirSync(LOG_DIR).filter((f) => f.endsWith(".json"));
  console.log(`\n  Log files: ${files.length}`);
  console.log(`  Min count: ${MIN_COUNT}`);
  console.log(`  Backend:   ${BACKEND}`);

  // Extract all reviewed tool calls (those that went through judge)
  const reviewed: ReviewedCall[] = [];

  for (const file of files) {
    const log = JSON.parse(readFileSync(join(LOG_DIR, file), "utf8"));
    const originalTask = log.originalTask ?? "(unknown)";
    const sessionId = log.sessionId ?? file;

    // From interceptor log
    if (log.interceptorLog) {
      for (const entry of log.interceptorLog) {
        if (entry.stage === "judge-allow" || entry.stage === "judge-deny") {
          reviewed.push({
            tool: entry.tool,
            inputSummary: entry.reason,
            stage: entry.stage,
            allowed: entry.allowed,
            similarity: entry.similarity,
            reason: entry.reason,
            originalTask,
            sessionId,
          });
        }
      }
    }

    // From tool history
    if (log.toolHistory) {
      for (const tc of log.toolHistory) {
        // Check if this was a review decision
        const policy = evaluateToolPolicy(tc.tool, tc.input ?? {});
        if (policy.decision === "review") {
          reviewed.push({
            tool: tc.tool,
            inputSummary: JSON.stringify(tc.input ?? {}).substring(0, 100),
            stage: tc.decision === "allow" ? "judge-allow" : "judge-deny",
            allowed: tc.decision === "allow",
            similarity: tc.similarity,
            reason: `Policy: ${policy.reason}`,
            originalTask,
            sessionId,
          });
        }
      }
    }
  }

  console.log(`  Reviewed tool calls found: ${reviewed.length}`);

  if (reviewed.length === 0) {
    console.log("\n  No reviewed tool calls found. Nothing to analyse.");
    console.log("  (Only tool calls that went through Stage 3 LLM judge are reviewed)");
    console.log("█".repeat(60));
    return;
  }

  // Group by pattern
  const groups = new Map<string, PatternGroup>();

  for (const call of reviewed) {
    let pattern: string;
    try {
      const input = JSON.parse(call.inputSummary);
      pattern = normalisePattern(call.tool, input);
    } catch {
      pattern = `${call.tool}(${call.inputSummary.substring(0, 40)})`;
    }

    if (!groups.has(pattern)) {
      groups.set(pattern, {
        pattern,
        tool: call.tool,
        examples: [],
        count: 0,
        allowedCount: 0,
        deniedCount: 0,
        avgSimilarity: 0,
      });
    }

    const group = groups.get(pattern)!;
    group.count++;
    if (call.allowed) group.allowedCount++;
    else group.deniedCount++;
    if (call.similarity !== null) {
      group.avgSimilarity =
        (group.avgSimilarity * (group.count - 1) + call.similarity) / group.count;
    }
    if (group.examples.length < 3) {
      group.examples.push(call);
    }
  }

  // Filter by min count
  const patterns = Array.from(groups.values())
    .filter((g) => g.count >= MIN_COUNT)
    .sort((a, b) => b.count - a.count);

  console.log(`  Unique patterns: ${groups.size}`);
  console.log(`  Patterns meeting min count (${MIN_COUNT}): ${patterns.length}\n`);

  if (patterns.length === 0) {
    console.log("  No patterns meet the minimum count threshold.");
    console.log("█".repeat(60));
    return;
  }

  // Review each pattern with LLM
  const recommendations: Recommendation[] = [];

  for (const group of patterns) {
    console.log(`─`.repeat(60));
    console.log(`  Pattern: ${group.pattern}`);
    console.log(`  Count: ${group.count} (${group.allowedCount} allowed, ${group.deniedCount} denied)`);
    console.log(`  Avg similarity: ${group.avgSimilarity.toFixed(3)}`);

    const examplesStr = group.examples
      .map(
        (e, i) =>
          `  Example ${i + 1}:\n` +
          `    Task: ${e.originalTask.substring(0, 80)}\n` +
          `    Judge: ${e.stage} — ${e.reason.substring(0, 100)}`
      )
      .join("\n");

    const userMessage =
      `PATTERN: ${group.pattern}\n` +
      `TOOL: ${group.tool}\n` +
      `OCCURRENCES: ${group.count} (${group.allowedCount} allowed, ${group.deniedCount} denied)\n` +
      `AVG SIMILARITY TO ORIGINAL TASK: ${group.avgSimilarity.toFixed(3)}\n\n` +
      `EXAMPLES:\n${examplesStr}\n\n` +
      `Should this pattern be added to the allow list, deny list, or kept as review?`;

    try {
      const response = await callLLM(REVIEW_PROMPT, userMessage);

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const rec: Recommendation = {
          pattern: group.pattern,
          tool: group.tool,
          decision: parsed.decision ?? "keep-as-review",
          confidence: parsed.confidence ?? 0.5,
          reasoning: parsed.reasoning ?? "No reasoning provided",
          proposedRule: parsed.proposedRule ?? null,
          count: group.count,
        };
        recommendations.push(rec);

        const icon =
          rec.decision === "add-to-allow" ? "✓" :
          rec.decision === "add-to-deny" ? "✗" : "?";
        console.log(`  Recommendation: ${icon} ${rec.decision} (conf: ${rec.confidence.toFixed(2)})`);
        console.log(`  Reasoning: ${rec.reasoning}`);
        if (rec.proposedRule) {
          console.log(`  Proposed rule: ${rec.proposedRule}`);
        }
      }
    } catch (err) {
      console.log(`  Error reviewing: ${err instanceof Error ? err.message : String(err)}`);
      recommendations.push({
        pattern: group.pattern,
        tool: group.tool,
        decision: "keep-as-review",
        confidence: 0,
        reasoning: "Review failed",
        proposedRule: null,
        count: group.count,
      });
    }
  }

  // Summary
  console.log(`\n${"█".repeat(60)}`);
  console.log("  RECOMMENDATIONS");
  console.log("█".repeat(60));

  const toAllow = recommendations.filter((r) => r.decision === "add-to-allow");
  const toDeny = recommendations.filter((r) => r.decision === "add-to-deny");
  const keepReview = recommendations.filter((r) => r.decision === "keep-as-review");

  if (toAllow.length > 0) {
    console.log(`\n  ADD TO ALLOW LIST (${toAllow.length}):`);
    for (const r of toAllow) {
      console.log(`    ${r.pattern} (seen ${r.count}x, conf: ${r.confidence.toFixed(2)})`);
      console.log(`      ${r.reasoning}`);
      if (r.proposedRule) console.log(`      Rule: ${r.proposedRule}`);
    }
  }

  if (toDeny.length > 0) {
    console.log(`\n  ADD TO DENY LIST (${toDeny.length}):`);
    for (const r of toDeny) {
      console.log(`    ${r.pattern} (seen ${r.count}x, conf: ${r.confidence.toFixed(2)})`);
      console.log(`      ${r.reasoning}`);
      if (r.proposedRule) console.log(`      Rule: ${r.proposedRule}`);
    }
  }

  if (keepReview.length > 0) {
    console.log(`\n  KEEP AS REVIEW (${keepReview.length}):`);
    for (const r of keepReview) {
      console.log(`    ${r.pattern} (seen ${r.count}x, conf: ${r.confidence.toFixed(2)})`);
      console.log(`      ${r.reasoning}`);
    }
  }

  // Write recommendations to file
  const outFile = join(LOG_DIR, `policy-review-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outFile, JSON.stringify({ timestamp: new Date().toISOString(), patterns: patterns.length, recommendations }, null, 2));
  console.log(`\n  Recommendations saved to ${outFile}`);
  console.log("█".repeat(60));
}

main().catch(console.error);
