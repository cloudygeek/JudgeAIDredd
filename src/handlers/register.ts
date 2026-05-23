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
  authenticateHookRequest,
} from "../server-core.js";

export async function handleRegister(req: IncomingMessage, res: ServerResponse) {
  // Auth: Bearer API key. /register is the benchmark-harness entrypoint;
  // benchmark scripts already carry a key. A previous version accepted
  // anonymous POSTs, which let an attacker mint sessions with arbitrary
  // task strings (and then read them via /session/:id). Owner is stamped
  // from the validated key.
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;
  const body = JSON.parse(await readBody(req));
  const { task } = body;
  if (!task) {
    return json(res, 400, { error: "Missing task" });
  }
  const sessionId = `bench-${randomUUID()}`;
  await tracker.registerIntent(sessionId, task, CONFIG.mode === "interactive");
  if (identity.ownerSub) {
    await tracker.setSessionOwner(sessionId, identity.ownerSub, identity.ownerEmail).catch(() => {});
  }
  await interceptor.registerGoal(sessionId, task);
  registeredSessions.add(sessionId);
  console.log(
    `  [${sessionId.substring(0, 8)}] [REGISTER] benchmark session by ${identity.ownerEmail ?? identity.ownerSub ?? "?"}: "${task.substring(0, 60)}..."`,
  );
  json(res, 200, { session: sessionId });
}
