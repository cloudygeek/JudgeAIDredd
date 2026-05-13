/**
 * POST /pivot — explicit user direction change.
 * POST /compact — PreCompact notification (Claude Code about to compact context).
 *
 * Pivot wipes the session's interceptor/registered state so the next
 * /intent is treated as a fresh task. Compact just records a turn-
 * metrics row for telemetry — no state change.
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
} from "../server-core.js";
import { cancelPendingClassification } from "../intent-classifier.js";

export async function handlePivot(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id, reason } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  await tracker.pivotSession(session_id, reason ?? "User changed direction");

  interceptor.reset(session_id);
  registeredSessions.delete(session_id);
  cancelPendingClassification(session_id);

  json(res, 200, { pivoted: true, reason: reason ?? "User changed direction" });
}

export async function handleCompact(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id } = body;

  if (rejectInvalidSessionId(res, session_id)) return;

  console.log(
    `  [COMPACT] Session ${session_id.substring(0, 8)}: context compaction detected`
  );

  await tracker.recordTurnMetrics(
    session_id,
    null,
    null,
    0,
    0,
    false,
    false
  );

  json(res, 200, { noted: true });
}
