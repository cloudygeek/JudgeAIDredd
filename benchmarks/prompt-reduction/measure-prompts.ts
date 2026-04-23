#!/usr/bin/env node
/**
 * Prompt-reduction benchmark.
 *
 * Replays a trace of tool calls against a running Judge Dredd server in
 * interactive mode and counts how many would escalate to the human
 * (drifting + hijacked verdicts) versus the per-action-approval baseline
 * (every tool call is a prompt).
 *
 * Output: per-verdict log + reduction summary.
 *
 * Run with: npx tsx measure-prompts.ts [flags]
 * See README.md for flag docs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

type Args = {
  trace: string;
  profile: "light" | "moderate" | "heavy" | null;
  dreddUrl: string;
  reps: number;
  out: string;
  humanSimulate: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    trace: "traces/moderate-profile-median.json",
    profile: null,
    dreddUrl: process.env.DREDD_URL ?? "http://localhost:3456",
    reps: 1,
    out: `results/run-${Date.now()}.json`,
    humanSimulate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--trace": a.trace = v; i++; break;
      case "--profile": a.profile = v as Args["profile"]; i++; break;
      case "--dredd-url": a.dreddUrl = v; i++; break;
      case "--reps": a.reps = parseInt(v, 10); i++; break;
      case "--out": a.out = v; i++; break;
      case "--human-simulate": a.humanSimulate = true; break;
      case "--help":
      case "-h":
        console.log("See README.md for flag docs.");
        process.exit(0);
    }
  }
  if (a.profile) {
    a.trace = `traces/${a.profile}-profile-median.json`;
  }
  return a;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolCall = {
  tool: string;
  parameters: Record<string, unknown>;
};

type Trace = {
  originating_task: string;
  tool_calls: ToolCall[];
};

type Verdict = "consistent" | "drifting" | "hijacked";

type EvaluateResponse = {
  verdict: Verdict;
  confidence: number;
  rationale: string;
};

type VerdictLogEntry = {
  index: number;
  tool: string;
  parameters: Record<string, unknown>;
  verdict: Verdict;
  confidence: number;
  rationale: string;
  escalated_to_human: boolean;
  latency_ms: number;
};

// ---------------------------------------------------------------------------
// Wilson 95% confidence interval for a proportion k/n
// ---------------------------------------------------------------------------

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.959963984540054; // 95%
  const p = k / n;
  const denom = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// ---------------------------------------------------------------------------
// Dredd server interaction
// ---------------------------------------------------------------------------

async function registerSession(dreddUrl: string, task: string): Promise<string> {
  const res = await fetch(`${dreddUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task }),
  });
  if (!res.ok) {
    throw new Error(`/register failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { session: string };
  return body.session;
}

async function evaluateToolCall(
  dreddUrl: string,
  session: string,
  call: ToolCall,
): Promise<{ verdict: Verdict; confidence: number; rationale: string; latencyMs: number }> {
  const t0 = performance.now();
  const res = await fetch(`${dreddUrl}/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, proposed_action: call }),
  });
  const latencyMs = Math.round(performance.now() - t0);
  if (!res.ok) {
    throw new Error(`/evaluate failed at call ${call.tool}: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as EvaluateResponse;
  return { ...body, latencyMs };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Benchmark loop
// ---------------------------------------------------------------------------

async function runOnce(
  dreddUrl: string,
  trace: Trace,
  humanSimulate: boolean,
): Promise<VerdictLogEntry[]> {
  const session = await registerSession(dreddUrl, trace.originating_task);
  const log: VerdictLogEntry[] = [];

  for (let i = 0; i < trace.tool_calls.length; i++) {
    const call = trace.tool_calls[i];
    const { verdict, confidence, rationale, latencyMs } =
      await evaluateToolCall(dreddUrl, session, call);

    const escalated = verdict !== "consistent";

    log.push({
      index: i,
      tool: call.tool,
      parameters: call.parameters,
      verdict,
      confidence,
      rationale,
      escalated_to_human: escalated,
      latency_ms: latencyMs,
    });

    // Simulate the human approving an escalated prompt after 100 ms so the
    // wall-clock duration of the run reflects an interactive session.
    if (escalated && humanSimulate) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return log;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function summarise(
  allLogs: VerdictLogEntry[][],
  trace: Trace,
  args: Args,
  startedAt: string,
  durationMs: number,
): {
  summary: Record<string, unknown>;
  text: string;
} {
  const flat = allLogs.flat();
  const total = flat.length;
  const counts = {
    consistent: flat.filter((e) => e.verdict === "consistent").length,
    drifting: flat.filter((e) => e.verdict === "drifting").length,
    hijacked: flat.filter((e) => e.verdict === "hijacked").length,
  };
  const escalated = counts.drifting + counts.hijacked;
  const baselinePrompts = total; // every call is a prompt under per-action approval
  const reduction = total === 0 ? 0 : 1 - escalated / total;
  const wilson95 = wilson(counts.consistent, total);

  // Per-session figures (dividing by reps)
  const callsPerSession = trace.tool_calls.length;
  const escalatedPerSession = escalated / args.reps;
  const reductionCI: [number, number] = [
    1 - wilson95[1],
    1 - wilson95[0],
  ];

  // Attention-time cost model: 3 s per prompt (see paper §7.3)
  const secondsPerPrompt = 3;
  const baselineInterruptionSec = callsPerSession * secondsPerPrompt;
  const dreddInterruptionSec = escalatedPerSession * secondsPerPrompt;

  const traceContents = readFileSync(args.trace, "utf8");
  const traceSha = sha256(traceContents);

  const summary = {
    build: {
      gitSha: gitSha(),
      dreddUrl: args.dreddUrl,
    },
    trace: {
      path: args.trace,
      sha256: traceSha,
      originatingTask: trace.originating_task,
      toolCallsPerSession: callsPerSession,
    },
    run: {
      startedAt,
      durationMs,
      reps: args.reps,
      humanSimulate: args.humanSimulate,
    },
    results: {
      totalCalls: total,
      verdicts: counts,
      escalatedToHuman: escalated,
      reductionVsBaseline: reduction,
      wilson95OnReduction: reductionCI,
      perSession: {
        baselinePrompts: callsPerSession,
        dreddPrompts: escalatedPerSession,
        reductionPct: 100 * (1 - escalatedPerSession / callsPerSession),
      },
      attentionTimeModel: {
        secondsPerPrompt,
        baselineSecPerSession: baselineInterruptionSec,
        dreddSecPerSession: dreddInterruptionSec,
        recoveredSecPerSession: baselineInterruptionSec - dreddInterruptionSec,
      },
    },
    log: flat,
  };

  const text = [
    "",
    `Trace:              ${args.trace}  (${callsPerSession} tool calls)`,
    `Reps:               ${args.reps}`,
    `Dredd URL:          ${args.dreddUrl}`,
    `Human-simulate:     ${args.humanSimulate}`,
    "",
    "Verdict distribution",
    `  consistent        ${counts.consistent.toString().padStart(5)}   (${(100 * counts.consistent / total).toFixed(1)} %)`,
    `  drifting          ${counts.drifting.toString().padStart(5)}   (${(100 * counts.drifting / total).toFixed(1)} %)`,
    `  hijacked          ${counts.hijacked.toString().padStart(5)}   (${(100 * counts.hijacked / total).toFixed(1)} %)`,
    "",
    "Prompts escalated to human (per session)",
    `  with Judge Dredd        ${escalatedPerSession.toFixed(2)}`,
    `  baseline (per-action)   ${callsPerSession}`,
    `  reduction               ${(100 * (1 - escalatedPerSession / callsPerSession)).toFixed(1)} %`,
    `                           Wilson 95 % CI on total-call reduction: ` +
      `${(100 * reductionCI[0]).toFixed(1)}-${(100 * reductionCI[1]).toFixed(1)} %`,
    "",
    "Per-session attention-time cost (at 3 s per prompt)",
    `  baseline interruption   ${baselineInterruptionSec} s`,
    `  with Dredd              ${dreddInterruptionSec.toFixed(1)} s`,
    `  recovered               ${(baselineInterruptionSec - dreddInterruptionSec).toFixed(1)} s  ` +
      `(~${((baselineInterruptionSec - dreddInterruptionSec) / 60).toFixed(2)} min/session)`,
    "",
    `Full verdict log written to: ${args.out}`,
    "",
  ].join("\n");

  return { summary, text };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tracePath = resolve(args.trace);
  if (!existsSync(tracePath)) {
    console.error(`Trace not found: ${tracePath}`);
    console.error(`Try: --profile moderate  (uses shipped trace)`);
    process.exit(2);
  }
  const trace: Trace = JSON.parse(readFileSync(tracePath, "utf8"));

  // Health check: fail fast if server is unreachable.
  try {
    const res = await fetch(`${args.dreddUrl}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (e) {
    console.error(`Judge Dredd server unreachable at ${args.dreddUrl}: ${e}`);
    console.error(`Start one with:  npm run server:bedrock:interactive`);
    process.exit(3);
  }

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const allLogs: VerdictLogEntry[][] = [];
  for (let r = 0; r < args.reps; r++) {
    process.stderr.write(`\rrun ${r + 1}/${args.reps}`);
    allLogs.push(await runOnce(args.dreddUrl, trace, args.humanSimulate));
  }
  process.stderr.write(`\n`);
  const durationMs = Math.round(performance.now() - t0);

  const { summary, text } = summarise(allLogs, trace, args, startedAt, durationMs);

  // Persist results
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(resolve(args.out), JSON.stringify(summary, null, 2));

  console.log(text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
