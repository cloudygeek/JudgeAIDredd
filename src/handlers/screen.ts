/**
 * POST /screen — PromptArmor side-channel for benchmark runners.
 *
 * Body: {
 *   content: string,           // untrusted blob to screen
 *   task_context?: string,     // forward-compat — currently logged only
 *   backend: "openai" | "bedrock",
 *   model: string,             // must be one of PROMPTARMOR_ALLOWED_MODELS
 *   run_id?: string,           // appends to results/promptarmor/<run_id>/calls.jsonl
 *   temperature?: number,      // default 0
 * }
 *
 * Auth: same Bearer-key gate as the rest of the hook surface.
 * Side-effects: appends to the run's calls.jsonl when run_id is set.
 *   Does NOT touch SessionTracker — this is benchmark plumbing, not a
 *   Dredd-protected operation.
 *
 * Concurrency is capped (PROMPTARMOR_SCREEN_CONCURRENCY env, default 8)
 * so a stuck Bedrock call can't queue hundreds of in-flight requests
 * on the event loop. Observed outage 2026-05-10 caused by the hook
 * going quiet after a stuck /screen call hung the event loop.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  readBody,
  json,
  authenticateHookRequest,
} from "../server-core.js";

const PROMPTARMOR_ALLOWED_MODELS: ReadonlyArray<string> = [
  "gpt-4o",
  "gpt-4.1",
  "o4-mini",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "qwen3-32b",
  "qwen3-235b",
];

const PROMPTARMOR_MAX_CONTENT_BYTES = 32 * 1024;

const PROMPTARMOR_SCREEN_CONCURRENCY = parseInt(
  process.env.PROMPTARMOR_SCREEN_CONCURRENCY ?? "8",
  10,
);
let screenInFlight = 0;
const screenWaiters: Array<() => void> = [];

function acquireScreenSlot(): Promise<void> {
  if (screenInFlight < PROMPTARMOR_SCREEN_CONCURRENCY) {
    screenInFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    screenWaiters.push(() => {
      screenInFlight++;
      resolve();
    });
  });
}

function releaseScreenSlot(): void {
  screenInFlight--;
  const next = screenWaiters.shift();
  if (next) next();
}

export async function handleScreen(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const content = body.content;
  const taskContext = body.task_context;
  const backend = body.backend;
  const model = body.model;
  const runId = body.run_id;
  const temperature = body.temperature;

  if (typeof content !== "string") {
    return json(res, 400, { error: "content must be a string" });
  }
  if (Buffer.byteLength(content, "utf8") > PROMPTARMOR_MAX_CONTENT_BYTES) {
    return json(res, 413, {
      error: `content exceeds ${PROMPTARMOR_MAX_CONTENT_BYTES} bytes`,
    });
  }
  if (taskContext !== undefined && typeof taskContext !== "string") {
    return json(res, 400, { error: "task_context must be a string when provided" });
  }
  if (backend !== "openai" && backend !== "bedrock") {
    return json(res, 400, { error: "backend must be openai or bedrock" });
  }
  if (typeof model !== "string" || !PROMPTARMOR_ALLOWED_MODELS.some((m) => model.includes(m))) {
    return json(res, 400, {
      error: `model not allowed; must contain one of: ${PROMPTARMOR_ALLOWED_MODELS.join(", ")}`,
    });
  }
  if (runId !== undefined && (typeof runId !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(runId))) {
    return json(res, 400, { error: "run_id must match [a-zA-Z0-9._-]{1,64}" });
  }
  if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) {
    return json(res, 400, { error: "temperature must be a number in [0, 2]" });
  }

  const { PromptArmorBaseline } = await import("../promptarmor-baseline.js");
  const baseline = new PromptArmorBaseline({
    backend,
    model,
    temperature,
    runId,
  });

  await acquireScreenSlot();
  try {
    const result = await baseline.screen(content, taskContext);
    return json(res, 200, {
      verdict: result.verdict,
      sanitised: result.sanitised,
      latency_ms: result.latencyMs,
      tokens: { in: result.tokens.in, out: result.tokens.out },
      injection: result.injection,
      sanitisation_failed: result.sanitisationFailed,
      run_id: runId ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [/screen] backend ${backend} failed: ${msg}`);
    return json(res, 502, { error: "detector backend failed", detail: msg });
  } finally {
    releaseScreenSlot();
  }
}
