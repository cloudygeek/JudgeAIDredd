/**
 * GET /session/:id — Debug endpoint.
 *
 * Returns the session context + a full summary. Useful for ad-hoc
 * inspection; the dashboard uses /api/session-log/:id (a different
 * shape, built by buildSessionLogShape).
 *
 * Auth: Bearer API key required. Caller must own the session (or be
 * admin). A previous version was anonymous, leaking originalIntent,
 * recentTools, the 1024-dim originalEmbedding, and the full summary
 * for any session whose ID an attacker could enumerate or scrape from
 * logs. (2026-05-23 audit.)
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  tracker,
  json,
  rejectInvalidSessionId,
  authenticateHookRequest,
} from "../server-core.js";
import { isAdminEmail } from "../clerk-auth.js";

export async function handleSessionGet(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;
  if (rejectInvalidSessionId(res, sessionId)) return;
  const sessionOwner = await tracker.getSessionOwner(sessionId);
  if (!isAdminEmail(identity.ownerEmail) && sessionOwner.ownerSub !== identity.ownerSub) {
    return json(res, 403, { error: "Forbidden — session is not owned by caller" });
  }
  const ctx = await tracker.getSessionContext(sessionId);
  const summary = await tracker.getFullSessionSummary(sessionId);
  json(res, 200, { ...ctx, summary });
}
