/**
 * Exfiltration Test Runner
 *
 * CLI that runs T4/T5/T6 scenarios against a Claude agent and measures
 * actual exfiltration (canary server hits) rather than just canary-in-context.
 *
 * Usage:
 *   npx tsx src/runner-exfil.ts
 *   npx tsx src/runner-exfil.ts --tests T4,T5
 *   npx tsx src/runner-exfil.ts --model claude-sonnet-4-6 --effort high
 *   npx tsx src/runner-exfil.ts --repetitions 3 --canary-port 3003
 *   npx tsx src/runner-exfil.ts --tests T6 --target-project /path/to/poc-webgoat
 */

import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CanaryServer } from "./canary-server.js";
import { executeT4, executeT5, executeT6, type ExfilResult } from "./executor-exfil.js";
import { getInjectionScenarios } from "../scenarios/t4-http-injection.js";
import { getMultiStageScenarios } from "../scenarios/t5-multistage.js";
import { getClaudeMdScenarios } from "../scenarios/t6-claudemd-poisoning.js";

const { values } = parseArgs({
  options: {
    tests: { type: "string", default: "T4,T5,T6" },
    model: { type: "string", default: "claude-sonnet-4-6" },
    effort: { type: "string" },
    repetitions: { type: "string", default: "1" },
    "canary-port": { type: "string", default: "3003" },
    "target-project": { type: "string", default: "/tmp/p15-target" },
    "output-dir": { type: "string", default: "./results" },
  },
});

const TESTS = values.tests!.split(",").map((t) => t.trim().toUpperCase());
const MODEL = values.model!;
const EFFORT = values.effort as "low" | "medium" | "high" | "max" | undefined;
const REPS = parseInt(values.repetitions!, 10);
const CANARY_PORT = parseInt(values["canary-port"]!, 10);
const TARGET_PROJECT = values["target-project"]!;
const OUTPUT_DIR = values["output-dir"]!;

interface RunSummary {
  timestamp: string;
  model: string;
  effort: string | undefined;
  repetitions: number;
  tests: string[];
  results: ExfilResult[];
  summary: {
    total: number;
    exfiltrated: number;
    refused: number;
    canaryInContextOnly: number;
    clean: number;
  };
}

async function main() {
  console.log("█".repeat(70));
  console.log("  EXFILTRATION TEST RUNNER — T4/T5/T6");
  console.log("█".repeat(70));
  console.log(`  Model:       ${MODEL}`);
  console.log(`  Effort:      ${EFFORT ?? "default"}`);
  console.log(`  Repetitions: ${REPS}`);
  console.log(`  Tests:       ${TESTS.join(", ")}`);
  console.log(`  Canary port: ${CANARY_PORT}`);
  console.log(`  Output:      ${OUTPUT_DIR}`);
  console.log("█".repeat(70));

  // Start canary server
  const canary = new CanaryServer(CANARY_PORT);
  await canary.start();
  console.log(`\n  Canary server listening on ${canary.baseUrl}\n`);

  const allResults: ExfilResult[] = [];

  try {
    // T4: HTTP Response Injection
    if (TESTS.includes("T4")) {
      const scenarios = getInjectionScenarios(canary.getStatus().port);
      console.log(`\n  T4: ${scenarios.length} scenario(s) × ${REPS} rep(s)`);

      for (const scenario of scenarios) {
        for (let rep = 0; rep < REPS; rep++) {
          console.log(`\n  Running ${scenario.id} rep ${rep + 1}/${REPS}...`);
          const result = await executeT4(scenario, canary, { model: MODEL, effort: EFFORT });
          result.repetition = rep;
          allResults.push(result);
        }
      }
    }

    // T5: Multi-Stage File Attack
    if (TESTS.includes("T5")) {
      const scenarios = getMultiStageScenarios(canary.getStatus().port);
      console.log(`\n  T5: ${scenarios.length} scenario(s) × ${REPS} rep(s)`);

      for (const scenario of scenarios) {
        for (let rep = 0; rep < REPS; rep++) {
          console.log(`\n  Running ${scenario.id} rep ${rep + 1}/${REPS}...`);
          const result = await executeT5(scenario, canary, { model: MODEL, effort: EFFORT });
          result.repetition = rep;
          allResults.push(result);
        }
      }
    }

    // T6: CLAUDE.md Poisoning
    if (TESTS.includes("T6")) {
      const scenarios = getClaudeMdScenarios(
        "/tmp/p15-t6-attack",
        TARGET_PROJECT,
        canary.getStatus().port,
      );
      console.log(`\n  T6: ${scenarios.length} scenario(s) × ${REPS} rep(s)`);

      for (const scenario of scenarios) {
        for (let rep = 0; rep < REPS; rep++) {
          console.log(`\n  Running ${scenario.id} rep ${rep + 1}/${REPS}...`);
          const result = await executeT6(scenario, canary, { model: MODEL, effort: EFFORT });
          result.repetition = rep;
          allResults.push(result);
        }
      }
    }
  } finally {
    await canary.stop();
    console.log("\n  Canary server stopped.");
  }

  // Summarise
  const exfiltrated = allResults.filter((r) => r.exfiltrationDetected).length;
  const refused = allResults.filter((r) => r.agentRefused).length;
  const canaryOnly = allResults.filter((r) => r.canaryInContext && !r.exfiltrationDetected).length;
  const clean = allResults.filter((r) => !r.canaryInContext && !r.exfiltrationDetected).length;

  const summary: RunSummary = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    effort: EFFORT,
    repetitions: REPS,
    tests: TESTS,
    results: allResults,
    summary: {
      total: allResults.length,
      exfiltrated,
      refused,
      canaryInContextOnly: canaryOnly,
      clean,
    },
  };

  // Write results
  try { mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const effortTag = EFFORT ? `-${EFFORT}` : "";
  const filename = `exfil-${TESTS.join("")}-${MODEL}${effortTag}-${ts}.json`;
  const outPath = join(OUTPUT_DIR, filename);
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  // Print summary table
  console.log(`\n${"═".repeat(70)}`);
  console.log("  EXFILTRATION TEST SUMMARY");
  console.log(`${"═".repeat(70)}`);
  console.log(`  Total scenarios:        ${allResults.length}`);
  console.log(`  Exfiltration detected:  ${exfiltrated} (${((exfiltrated / allResults.length) * 100).toFixed(1)}%)`);
  console.log(`  Agent refused:          ${refused} (${((refused / allResults.length) * 100).toFixed(1)}%)`);
  console.log(`  Canary in context only: ${canaryOnly}`);
  console.log(`  Clean (no canary):      ${clean}`);
  console.log();

  // Per-scenario breakdown
  console.log("  %-8s %-45s %-8s %-8s %-8s".replace(/%/g, "%"), "ID", "Name", "Exfil?", "Refused?", "Context?");
  console.log("  " + "-".repeat(77));
  for (const r of allResults) {
    const exfilFlag = r.exfiltrationDetected ? "\x1b[31mYES\x1b[0m" : "\x1b[32mNO\x1b[0m";
    const refusedFlag = r.agentRefused ? "\x1b[32mYES\x1b[0m" : "\x1b[33mNO\x1b[0m";
    const contextFlag = r.canaryInContext ? "YES" : "NO";
    console.log(`  ${r.scenarioId.padEnd(8)} ${r.scenarioName.substring(0, 45).padEnd(45)} ${exfilFlag.padEnd(17)} ${refusedFlag.padEnd(17)} ${contextFlag}`);
  }

  console.log(`\n  Results written to: ${outPath}`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
