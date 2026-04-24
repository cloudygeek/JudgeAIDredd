#!/usr/bin/env node
/**
 * Aggregate the per-trace results produced by run-corpus.sh into a
 * single summary.
 *
 * Input: directory containing <trace-name>.json files written by
 *        measure-prompts.ts (each carries its own `log`, verdict
 *        counts, and per-session metrics).
 * Output:
 *   - summary.json in the same directory, with per-trace rows and
 *     weighted corpus-level aggregates.
 *   - a human-readable table on stdout.
 *
 * Run with:  npx tsx aggregate-corpus.ts <dir>
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

type PerCallLog = {
  verdict: "consistent" | "drifting" | "hijacked";
  [k: string]: unknown;
};

type PerTraceResult = {
  trace: {
    path: string;
    sha256: string;
    originatingTask: string;
    toolCallsPerSession: number;
  };
  run: {
    reps: number;
    durationMs: number;
  };
  results: {
    totalCalls: number;
    verdicts: {
      consistent: number;
      drifting: number;
      hijacked: number;
    };
    escalatedToHuman: number;
    perSession: {
      baselinePrompts: number;
      dreddPrompts: number;
      reductionPct: number;
    };
  };
  log?: PerCallLog[];
};

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.959963984540054;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function fmtPct(x: number, width = 5) {
  return (100 * x).toFixed(1).padStart(width, " ") + " %";
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: aggregate-corpus.ts <results-dir>");
    process.exit(2);
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "summary.json")
    .sort();

  if (files.length === 0) {
    console.error(`no result JSONs found in ${dir}`);
    process.exit(2);
  }

  const perTrace = files.map((f) => {
    const data = JSON.parse(
      readFileSync(join(dir, f), "utf8"),
    ) as PerTraceResult;
    return { file: f, data };
  });

  // Corpus totals
  let totalCalls = 0;
  let totalConsistent = 0;
  let totalDrifting = 0;
  let totalHijacked = 0;
  let totalEscalated = 0;
  let totalBaselinePrompts = 0;

  const perTraceRows = perTrace.map(({ file, data }) => {
    const { results, trace, run } = data;
    totalCalls += results.totalCalls;
    totalConsistent += results.verdicts.consistent;
    totalDrifting += results.verdicts.drifting;
    totalHijacked += results.verdicts.hijacked;
    totalEscalated += results.escalatedToHuman;
    totalBaselinePrompts += trace.toolCallsPerSession * run.reps;

    const reduction =
      results.totalCalls === 0
        ? 0
        : 1 - results.escalatedToHuman / results.totalCalls;
    const ci = wilson(results.verdicts.consistent, results.totalCalls);

    return {
      trace: basename(file, ".json"),
      reps: run.reps,
      toolCallsPerSession: trace.toolCallsPerSession,
      totalCalls: results.totalCalls,
      consistent: results.verdicts.consistent,
      drifting: results.verdicts.drifting,
      hijacked: results.verdicts.hijacked,
      escalated: results.escalatedToHuman,
      escalatedPerSession: results.escalatedToHuman / run.reps,
      reductionPct: 100 * reduction,
      wilson95OnReduction: [
        100 * (1 - ci[1]),
        100 * (1 - ci[0]),
      ] as [number, number],
    };
  });

  const corpusReduction =
    totalCalls === 0 ? 0 : 1 - totalEscalated / totalCalls;
  const corpusCI = wilson(totalConsistent, totalCalls);

  const summary = {
    runDir: dir,
    tracesRun: perTraceRows.length,
    corpusTotals: {
      totalCalls,
      totalBaselinePrompts,
      verdicts: {
        consistent: totalConsistent,
        drifting: totalDrifting,
        hijacked: totalHijacked,
      },
      consistentRate: totalConsistent / totalCalls,
      driftingRate: totalDrifting / totalCalls,
      hijackedRate: totalHijacked / totalCalls,
      escalatedToHuman: totalEscalated,
      reductionVsBaseline: corpusReduction,
      wilson95OnReduction: [
        1 - corpusCI[1],
        1 - corpusCI[0],
      ] as [number, number],
    },
    perTrace: perTraceRows,
  };

  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );

  // Human-readable table
  const lines: string[] = [];
  lines.push(`\nCorpus summary  (${perTraceRows.length} traces, ${totalCalls} tool-call evaluations)\n`);
  lines.push(`${"Trace".padEnd(42)} ${"reps".padStart(4)} ${"calls".padStart(5)} ${"cons".padStart(5)} ${"drift".padStart(5)} ${"hijack".padStart(6)} ${"reduction".padStart(10)}`);
  lines.push(`${"-".repeat(42)} ${"-".repeat(4)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(6)} ${"-".repeat(10)}`);
  for (const r of perTraceRows) {
    lines.push(
      `${r.trace.padEnd(42)} ${String(r.reps).padStart(4)} ${String(r.totalCalls).padStart(5)} ${String(r.consistent).padStart(5)} ${String(r.drifting).padStart(5)} ${String(r.hijacked).padStart(6)} ${fmtPct(r.reductionPct / 100, 8)}`,
    );
  }
  lines.push("");
  lines.push(`Corpus-level weighted reduction: ${fmtPct(corpusReduction, 6)}`);
  lines.push(
    `Wilson 95 % CI:                   ${fmtPct(1 - corpusCI[1], 6)} .. ${fmtPct(1 - corpusCI[0], 6)}`,
  );
  lines.push("");
  lines.push(`Verdict distribution (corpus):`);
  lines.push(`  consistent  ${String(totalConsistent).padStart(6)}  (${fmtPct(totalConsistent / totalCalls, 5)})`);
  lines.push(`  drifting    ${String(totalDrifting).padStart(6)}  (${fmtPct(totalDrifting / totalCalls, 5)})`);
  lines.push(`  hijacked    ${String(totalHijacked).padStart(6)}  (${fmtPct(totalHijacked / totalCalls, 5)})`);
  lines.push("");
  lines.push(`Summary JSON: ${join(dir, "summary.json")}`);
  console.log(lines.join("\n"));
}

main();
