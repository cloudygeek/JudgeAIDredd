/**
 * Notification handlers.
 *
 * POST /notification fires on every Claude Code permission/notification
 * dialog — the only signal we have that the user got prompted despite
 * Dredd's PreToolUse decision. Per-session counter feeds the dashboard
 * friction metric.
 *
 * GET /api/notifications/:id reads back the counter for the friction
 * A/B harness which talks directly to the hook container.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  readBody,
  json,
  rejectInvalidSessionId,
  authenticateHookRequest,
  authStageForFeed,
  addFeed,
  recordNotification,
  getNotificationCount,
} from "../server-core.js";

export async function handleNotification(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id, message } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  const count = recordNotification(
    session_id,
    typeof message === "string" ? message : "",
  );

  addFeed({
    timestamp: new Date().toISOString(),
    type: "notification",
    sessionId: session_id,
    reason: typeof message === "string" ? message.substring(0, 500) : "",
    ownerSub: identity.ownerSub,
    authStage: authStageForFeed(identity),
  });

  json(res, 200, { count });
}

export function handleNotificationsGet(res: ServerResponse, sessionId: string) {
  if (rejectInvalidSessionId(res, sessionId)) return;
  json(res, 200, {
    sessionId,
    count: getNotificationCount(sessionId),
  });
}
