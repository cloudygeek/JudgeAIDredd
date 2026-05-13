/**
 * POST /register — Benchmark-compatible session registration.
 *
 * Used by the AgentDojo / InjecAgent harnesses that don't go through
 * Claude Code's UserPromptSubmit hook. Mints a session id, registers
 * the task as the original intent, and primes the interceptor.
 */

import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  tracker,
  interceptor,
  registeredSessions,
  CONFIG,
  readBody,
  json,
} from "../server-core.js";

export async function handleRegister(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { task } = body;
  if (!task) {
    return json(res, 400, { error: "Missing task" });
  }
  const sessionId = `bench-${randomUUID()}`;
  await tracker.registerIntent(sessionId, task, CONFIG.mode === "interactive");
  await interceptor.registerGoal(sessionId, task);
  registeredSessions.add(sessionId);
  console.log(`  [${sessionId.substring(0, 8)}] [REGISTER] benchmark session: "${task.substring(0, 60)}..."`);
  json(res, 200, { session: sessionId });
}
