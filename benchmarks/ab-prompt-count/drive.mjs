// drive.mjs — A/B harness driver
//
// Spawns a single `claude -p` process in stream-json IO mode and feeds it the
// 14-step task one user message per turn. Captures the full event stream to
// a JSONL file. Exits when the assistant says "DONE", when all steps are
// consumed, when permission_denials make further progress impossible, or
// after a hard timeout.
//
// Env (set by run.sh):
//   VARIANT          baseline | dredd
//   REPO             absolute path to the JudgeAIDredd checkout under test
//   OUT              output JSONL path
//   RUN_INDEX        integer for log labels
//   DREDD_URL        for the dredd variant only
//   DREDD_API_KEY    for the dredd variant only
//   DREDD_MODE       interactive (forced for B1)
//   AWS_REGION, CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL
//
// The driver does NOT invoke `claude` from a context that has any
// AWS_BEARER_TOKEN_BEDROCK set — that token shadows SigV4 and yields 403.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, createWriteStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

const VARIANT = process.env.VARIANT;
const REPO = process.env.REPO;
const OUT = process.env.OUT;
const RUN_INDEX = process.env.RUN_INDEX ?? "?";
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS ?? 90000);
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? 1200000); // 20 min

if (!VARIANT || !REPO || !OUT) {
  console.error("usage: VARIANT=... REPO=... OUT=... node drive.mjs");
  process.exit(2);
}

const HARNESS_DIR = path.dirname(new URL(import.meta.url).pathname);
const TASK_FILE = process.env.TASK_FILE || "task.json";
const taskDef = JSON.parse(readFileSync(path.join(HARNESS_DIR, TASK_FILE), "utf8"));
const STEPS = taskDef.steps;

// ---------- prep settings ----------------------------------------------------
//
// We write to `.claude/settings.json` (the project-level settings file) and
// pass `--setting-sources project` to claude. That way:
//   - the operator's user-level ~/.claude/settings.json (which already wires
//     dredd hooks on this machine) is excluded — preventing double-firing
//     in the dredd variant and unintended hook firing in the baseline
//   - claude actually loads our hook config (settings.local.json appears not
//     to wire hooks reliably under -p mode)
const claudeDir = path.join(REPO, ".claude");
mkdirSync(claudeDir, { recursive: true });

const projectSettingsPath = path.join(claudeDir, "settings.json");
if (VARIANT === "baseline") {
  writeFileSync(projectSettingsPath, JSON.stringify({
    permissions: { allow: [] },
    disableAllHooks: true,
  }, null, 2));
} else if (VARIANT === "dredd") {
  const settingsTemplate = readFileSync(path.join(HARNESS_DIR, "settings.template.json"), "utf8");
  const settings = settingsTemplate.replaceAll("__REPO__", REPO);
  writeFileSync(projectSettingsPath, settings);
} else {
  console.error(`[drive] unknown VARIANT=${VARIANT}`);
  process.exit(2);
}

// Belt-and-braces: also remove any settings.local.json a previous run may
// have left behind (or that the operator created locally).
const localPath = path.join(claudeDir, "settings.local.json");
if (existsSync(localPath)) unlinkSync(localPath);

// ---------- spawn claude -----------------------------------------------------
const env = { ...process.env };
delete env.AWS_BEARER_TOKEN_BEDROCK;
delete env.ANTHROPIC_API_KEY;
env.CLAUDE_CODE_USE_BEDROCK = "1";
env.AWS_REGION = env.AWS_REGION || "eu-west-2";
env.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || "eu.anthropic.claude-sonnet-4-6";
env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_SMALL_FAST_MODEL || "eu.anthropic.claude-haiku-4-5";

if (VARIANT === "dredd") {
  if (!env.DREDD_URL) {
    console.error("[drive] dredd variant requires DREDD_URL");
    process.exit(2);
  }
  // Force interactive mode regardless of whatever the deployed CONFIG.mode is.
  env.DREDD_MODE = env.DREDD_MODE || "interactive";
}

const args = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-hook-events",
  "--no-session-persistence",
  "--permission-mode", "default",
  // Only load .claude/settings.json (project sources). Excludes user-level
  // settings (which on the dev machine already wires dredd hooks and would
  // otherwise double-fire) and gitignored .local.json overrides.
  "--setting-sources", "project",
];

const child = spawn("claude", args, {
  cwd: REPO,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

const out = createWriteStream(OUT);
let done = false;
let sessionId = null;
let stepIdx = 0;
let pendingToolUses = new Set(); // tool_use ids waiting on tool_result
let lastEventAt = Date.now();
let assistantSaidDone = false;
let permissionDenialsTotal = 0;

// Claude requires at least one user message on stdin at startup or it exits
// with "Input must be provided either through stdin or as a prompt argument".
// Send the first step immediately; subsequent steps are sent on each `result`
// event.
function writeUser(text) {
  const msg = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
  child.stdin.write(JSON.stringify(msg) + "\n");
}
log(`-> step 1/${STEPS.length}: ${STEPS[0].substring(0, 80)}`);
writeUser(STEPS[0]);

function log(...args) {
  console.error(`[drive ${VARIANT}#${RUN_INDEX}]`, ...args);
}

function sendUserMessage(text) {
  log(`-> step ${stepIdx + 1}/${STEPS.length}: ${text.substring(0, 80)}`);
  writeUser(text);
}

// Buffer stdout into newline-delimited JSON.
let buf = "";
child.stdout.on("data", (chunk) => {
  lastEventAt = Date.now();
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    out.write(line + "\n");
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    handleEvent(evt);
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[claude stderr] ${chunk}`);
});

child.on("error", (err) => {
  log("spawn error:", err.message);
  process.exit(3);
});

child.on("exit", (code, signal) => {
  log(`claude exit: code=${code} signal=${signal} stepIdx=${stepIdx}/${STEPS.length} permission_denials=${permissionDenialsTotal}`);
  out.end();
  process.exit(code ?? 0);
});

function handleEvent(evt) {
  if (evt.type === "system" && evt.subtype === "init") {
    sessionId = evt.session_id;
    log(`session_id=${sessionId}`);
    return;
  }

  if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_use") {
        pendingToolUses.add(block.id);
      }
      if (block.type === "text" && /\bDONE\b/.test(block.text)) {
        assistantSaidDone = true;
      }
    }
    return;
  }

  if (evt.type === "user" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        pendingToolUses.delete(block.tool_use_id);
      }
    }
    return;
  }

  if (evt.type === "result") {
    permissionDenialsTotal = (evt.permission_denials ?? []).length;
    log(`result event: stop=${evt.stop_reason} num_turns=${evt.num_turns} permission_denials=${permissionDenialsTotal} is_error=${evt.is_error}`);
    // The assistant turn that handled the latest user message has ended. Either
    // advance to the next step or, if we've sent all steps and the model said
    // DONE (or we've simply exhausted the script), close stdin so claude exits.
    if (pendingToolUses.size > 0) {
      log(`! result event with ${pendingToolUses.size} pending tool_uses — clearing`);
      pendingToolUses.clear();
    }
    stepIdx += 1;
    if (assistantSaidDone || stepIdx >= STEPS.length) {
      done = true;
      log("closing stdin — task complete");
      child.stdin.end();
      return;
    }
    sendUserMessage(STEPS[stepIdx]);
  }
}

// Watchdogs
const startedAt = Date.now();
const watchdog = setInterval(() => {
  const sinceLast = Date.now() - lastEventAt;
  const sinceStart = Date.now() - startedAt;
  if (sinceStart > HARD_TIMEOUT_MS) {
    log(`hard timeout after ${HARD_TIMEOUT_MS}ms — killing claude`);
    child.kill("SIGKILL");
    clearInterval(watchdog);
    return;
  }
  if (sinceLast > STEP_TIMEOUT_MS) {
    log(`step timeout after ${STEP_TIMEOUT_MS}ms with no events — killing claude`);
    child.kill("SIGKILL");
    clearInterval(watchdog);
  }
}, 5000);
