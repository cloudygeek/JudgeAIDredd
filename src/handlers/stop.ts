/**
 * POST /stop — Claude Code Stop hook (turn boundary, NOT session end).
 *
 * Fires after every assistant turn. Updates the per-session timing
 * markers so the next /intent can derive turnState correctly:
 *   - lastStopAt updated to now
 *   - all activeIntents marked resolved (so the next "new-task"
 *     classification can evict them)
 *
 * Session end is /end (SessionEnd hook); this endpoint is purely a
 * turn-boundary signal.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  tracker,
  readBody,
  json,
  rejectInvalidSessionId,
  authenticateHookRequest,
} from "../server-core.js";

export async function handleStop(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  await tracker.noteStop(session_id).catch((err) => {
    console.warn(`  [${session_id.substring(0, 8)}] noteStop failed: ${err}`);
  });

  json(res, 200, {});
}
