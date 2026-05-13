/**
 * GET /session/:id — Debug endpoint.
 *
 * Returns the session context + a full summary. Useful for ad-hoc
 * inspection; the dashboard uses /api/session-log/:id (a different
 * shape, built by buildSessionLogShape).
 */

import { type ServerResponse } from "node:http";
import {
  tracker,
  json,
  rejectInvalidSessionId,
} from "../server-core.js";

export async function handleSessionGet(res: ServerResponse, sessionId: string) {
  if (rejectInvalidSessionId(res, sessionId)) return;
  const ctx = await tracker.getSessionContext(sessionId);
  const summary = await tracker.getFullSessionSummary(sessionId);
  json(res, 200, { ...ctx, summary });
}
