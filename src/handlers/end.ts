/**
 * POST /end — session shutdown (SessionEnd hook).
 *
 * Final hook in a session lifecycle. Logs a summary, evicts the
 * session from in-process state (registeredSessions, interceptor), and
 * tells the SessionStore to finalise. After this the session can still
 * be loaded from Dynamo for the dashboard, but no new tool calls will
 * register against it on this container.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  tracker,
  interceptor,
  registeredSessions,
  readBody,
  json,
  rejectInvalidSessionId,
  authenticateHookRequest,
  buildSessionLogShape,
} from "../server-core.js";
import { cancelPendingClassification } from "../intent-classifier.js";

export async function handleEnd(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  const sessionLog = await buildSessionLogShape(session_id);
  const summary = (sessionLog?.summary as any) ?? { turns: 0, toolCalls: 0, denied: 0 };

  console.log(
    `[END] Session ${session_id.substring(0, 8)}: ` +
    `${summary.turns} turns, ${summary.toolCalls} tools, ` +
    `${summary.denied} denied`
  );

  registeredSessions.delete(session_id);
  cancelPendingClassification(session_id);
  await tracker.endSession(session_id);
  interceptor.reset(session_id);

  json(res, 200, { summary });
}
