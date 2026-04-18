#!/usr/bin/env node
/**
 * AI Sandbox HTTP wrapper for the Test 7 batch runner.
 *
 * Listens on port 3000 (ALB requirement) and satisfies the health check at
 * GET / while providing a simple API to trigger and monitor batch runs.
 *
 * Routes:
 *   GET  /        — HTML status page; always returns 200 (ALB health check)
 *   GET  /status  — JSON run state
 *   GET  /logs    — plain-text log tail  (?n=N lines, default 100)
 *   POST /run     — start a run; body is JSON with optional overrides:
 *                     { models, scenarios, defences, reps,
 *                       s3Bucket, s3Prefix, s3Region, awsRegion, runId }
 *                   Returns 202 if accepted, 409 if a run is already in progress.
 */

import http from "http";
import { spawn } from "child_process";
import { readFileSync } from "fs";

const PORT = 3000;
const MAX_LOG_LINES = 20000;
const ENTRYPOINTS = {
  "1": "/docker-entrypoint-test1.sh",
  "3": "/docker-entrypoint-test3.sh",
  "3a": "/docker-entrypoint-test3a.sh",
  "4": "/docker-entrypoint-test4.sh",
  "7": "/docker-entrypoint.sh",
  "8": "/docker-entrypoint-test8.sh",
  "9": "/docker-entrypoint-test9.sh",
  "9a": "/docker-entrypoint-test9a.sh",
  "10": "/docker-entrypoint-test10.sh",
};
const DEFAULT_TEST = process.env.TEST_NUM || "7";
const BUILD_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

const INITIAL_PROGRESS = {
  totalCombinations: 0,
  completedCombinations: 0,
  failedCombinations: 0,
  completedRuns: 0,       // individual repetitions
  lastGES: null,
};

let state = {
  status: "idle",   // idle | running | done | failed
  runId: null,
  params: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  pid: null,
  logLines: [],
  progress: { ...INITIAL_PROGRESS },
};

let currentProcess = null;

function appendLog(line) {
  state.logLines.push(line);
  if (state.logLines.length > MAX_LOG_LINES) state.logLines.shift();
  process.stdout.write(line + "\n");

  // Track progress from log output
  // Total combinations: "[1/12]" pattern from entrypoint or ">>> N combinations queued"
  const totalMatch = line.match(/\[\d+\/(\d+)\]/);
  if (totalMatch) state.progress.totalCombinations = parseInt(totalMatch[1], 10);
  const queuedMatch = line.match(/>>> (\d+) combinations queued/);
  if (queuedMatch) state.progress.totalCombinations = parseInt(queuedMatch[1], 10);

  // Combination completed (Test 7: "Completed in", Test 3: "DONE in")
  if (/Completed in \d+s/.test(line) || /\] DONE in \d+s/.test(line)) {
    state.progress.completedCombinations++;
  }
  // Combination failed
  if (/WARNING: run failed/.test(line) || /\] FAILED:/.test(line)) {
    state.progress.completedCombinations++;
    state.progress.failedCombinations++;
  }

  // Individual test result (one per repetition)
  if (/^RESULT:/.test(line) || /^\s+RESULT:/.test(line)) {
    state.progress.completedRuns++;
  }
  // Extract GES from result blocks
  const gesMatch = line.match(/GES:\s+([\d.]+)/);
  if (gesMatch) state.progress.lastGES = parseFloat(gesMatch[1]);
}

function startRun(params) {
  const env = Object.assign({}, process.env);
  const testNum = String(params.test || DEFAULT_TEST);
  const entrypoint = ENTRYPOINTS[testNum];
  if (!entrypoint) {
    throw new Error(`Unknown test number: ${testNum}. Valid: ${Object.keys(ENTRYPOINTS).join(", ")}`);
  }

  // Test 7 env vars
  if (params.models)    env.TEST7_MODELS    = String(params.models);
  if (params.scenarios) env.TEST7_SCENARIOS = String(params.scenarios);
  if (params.defences)  env.TEST7_DEFENCES  = String(params.defences);
  if (params.reps)      env.TEST7_REPS      = String(params.reps);
  if (params.runId)     env.TEST7_RUN_ID    = String(params.runId);

  // Test 3 env vars
  if (params.models)    env.TEST3_MODELS    = String(params.models);
  if (params.scenarios) env.TEST3_SCENARIOS = String(params.scenarios);
  if (params.defences)  env.TEST3_DEFENCES  = String(params.defences);
  if (params.parallel)  env.PARALLEL_JOBS   = String(params.parallel);
  if (params.runId)     env.TEST3_RUN_ID    = String(params.runId);

  // Test 1 env vars
  if (params.effort)    env.TEST1_EFFORT    = String(params.effort);
  if (params.config)    env.TEST1_CONFIG    = String(params.config);

  // Test 3a env vars
  if (params.efforts)   env.TEST3A_EFFORTS  = String(params.efforts);
  if (params.reps)      env.TEST3A_REPS     = String(params.reps);
  if (params.runId)     env.TEST3A_RUN_ID   = String(params.runId);

  // Test 9a env vars
  if (params.matrix)    env.TEST9A_MATRIX   = String(params.matrix);
  if (params.reps)      env.TEST9A_REPS     = String(params.reps);
  if (params.runId)     env.TEST9A_RUN_ID   = String(params.runId);

  // Test 8 env vars
  if (params.effort)    env.TEST8_EFFORT    = String(params.effort);
  if (params.reps)      env.TEST8_REPS      = String(params.reps);
  if (params.models)    env.TEST8_MODELS    = String(params.models);

  // Test 10/11 env vars
  if (params.defences)      env.TEST10_DEFENCES     = String(params.defences);
  if (params.model)         env.TEST10_MODEL        = String(params.model);
  if (params.effort)        env.TEST10_EFFORT       = String(params.effort);
  if (params.judgeEffort)   env.TEST10_JUDGE_EFFORT = String(params.judgeEffort);
  if (params.reps)          env.TEST10_REPS         = String(params.reps);

  // Shared env vars
  if (params.s3Bucket)  env.S3_BUCKET       = String(params.s3Bucket);
  if (params.s3Prefix)  env.S3_PREFIX       = String(params.s3Prefix);
  if (params.s3Region)  env.S3_REGION       = String(params.s3Region);
  if (params.awsRegion) env.AWS_REGION      = String(params.awsRegion);
  if (params.bedrockRegion) env.BEDROCK_REGION = String(params.bedrockRegion);

  const runId = env.TEST7_RUN_ID || env.TEST3_RUN_ID || new Date().toISOString().replace(/[:.]/g, "");

  state = {
    status: "running",
    runId,
    params,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    pid: null,
    logLines: [],
    progress: { ...INITIAL_PROGRESS },
  };

  const child = spawn(entrypoint, [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.pid = child.pid;
  currentProcess = child;

  child.stdout.on("data", (data) => {
    data.toString().split("\n").filter(Boolean).forEach(appendLog);
  });

  child.stderr.on("data", (data) => {
    data.toString().split("\n").filter(Boolean).forEach((l) => appendLog("[ERR] " + l));
  });

  child.on("close", (code) => {
    state.status = code === 0 ? "done" : "failed";
    state.exitCode = code;
    state.finishedAt = new Date().toISOString();
    currentProcess = null;
    console.log(`Run ${runId} finished — exit code ${code}`);
  });

  child.on("error", (err) => {
    state.status = "failed";
    state.exitCode = -1;
    state.finishedAt = new Date().toISOString();
    currentProcess = null;
    appendLog("[ERROR] Failed to spawn entrypoint: " + err.message);
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost:" + PORT);

  // ── GET / — health check + status page ───────────────────────────────────
  if (req.method === "GET" && url.pathname === "/") {
    const colour = { idle: "#888", running: "#4af", done: "#4f4", failed: "#f44" }[state.status] || "#888";
    const logHtml = state.logLines.slice(-100)
      .map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
      .join("\n");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Judge AI Dredd — Test Runner</title>
  <link rel="icon" href="/favicon.ico" type="image/x-icon">
  <style>
    body { font-family: monospace; background: #111; color: #ccc; padding: 2em; margin: 0; }
    h1   { color: #fff; margin-top: 0; }
    h2   { color: #aaa; }
    .badge { display: inline-block; padding: .2em .8em; border-radius: 3px;
             background: ${colour}; color: #fff; font-weight: bold; }
    code { background: #1a1a1a; padding: .1em .4em; border-radius: 2px; }
    pre  { background: #1a1a1a; padding: 1em; border-radius: 4px;
           overflow: auto; max-height: 60vh; white-space: pre-wrap; word-break: break-all; }
    table { border-collapse: collapse; margin-top: .5em; }
    td, th { padding: .2em 1em .2em 0; text-align: left; }
  </style>
</head>
<body>
  <h1>Judge AI Dredd — Test Runner</h1>
  <p style="color:#666;margin-top:-.5em">v${BUILD_VERSION}</p>
  <table>
    <tr><th>Status</th>   <td><span class="badge">${state.status}</span></td></tr>
    ${state.runId      ? `<tr><th>Run ID</th>    <td><code>${state.runId}</code></td></tr>` : ""}
    ${state.startedAt  ? `<tr><th>Started</th>   <td><code>${state.startedAt}</code></td></tr>` : ""}
    ${state.finishedAt ? `<tr><th>Finished</th>  <td><code>${state.finishedAt}</code> (exit ${state.exitCode})</td></tr>` : ""}
    ${state.pid        ? `<tr><th>PID</th>       <td><code>${state.pid}</code></td></tr>` : ""}
    ${state.progress.totalCombinations > 0
      ? `<tr><th>Progress</th>  <td><strong>${state.progress.completedCombinations} / ${state.progress.totalCombinations}</strong> combinations${state.progress.failedCombinations ? ` (${state.progress.failedCombinations} failed)` : ""} &mdash; ${state.progress.completedRuns} runs completed${state.progress.lastGES !== null ? `, last GES: ${state.progress.lastGES}` : ""}</td></tr>`
      : ""}
  </table>
  ${state.status === "idle"
    ? "<p>No run in progress. <code>POST /run</code> with a JSON body to start one.</p>"
    : ""}
  <h2>Log (last 100 of ${state.logLines.length} lines)</h2>
  <pre>${logHtml || "(empty)"}</pre>
</body>
</html>`);
    return;
  }

  // ── GET /favicon.ico ──────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    try {
      const ico = readFileSync("/app/src/web/favicon.ico");
      res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" });
      res.end(ico);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  // ── GET /status — JSON state ──────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      version:     BUILD_VERSION,
      status:      state.status,
      runId:       state.runId,
      params:      state.params,
      startedAt:   state.startedAt,
      finishedAt:  state.finishedAt,
      exitCode:    state.exitCode,
      pid:         state.pid,
      bufferedLogLines: state.logLines.length,
      progress:    state.progress,
    }));
    return;
  }

  // ── GET /logs — plain-text log tail ──────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/logs") {
    const n = Math.min(parseInt(url.searchParams.get("n") || "100", 10), MAX_LOG_LINES);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(state.logLines.slice(-n).join("\n"));
    return;
  }

  // ── POST /run — start a run ───────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/run") {
    if (state.status === "running") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "A run is already in progress", runId: state.runId }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let params = {};
      try {
        if (body.trim()) params = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      startRun(params);
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Run started", runId: state.runId, status: "running" }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", path: url.pathname }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Judge AI Dredd v${BUILD_VERSION} listening on 0.0.0.0:${PORT} (default test: ${DEFAULT_TEST})`);
  console.log("  GET  /        health check + status page");
  console.log("  GET  /status  JSON run state");
  console.log("  GET  /logs    plain-text log tail (?n=N)");
  console.log("  POST /run     start a run (JSON body with optional overrides)");
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => {
  console.log("SIGTERM received — draining connections");
  server.close(() => {
    if (currentProcess) {
      console.log("Forwarding SIGTERM to runner process (pid " + currentProcess.pid + ")");
      currentProcess.kill("SIGTERM");
    }
    process.exit(0);
  });
});
