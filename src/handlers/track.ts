/**
 * POST /track — PostToolUse hook handler.
 *
 * Records the tool's actual execution result against the session.
 * For file ops, accumulates writes/reads in the session state so the
 * judge can see assembled payloads on subsequent /evaluate calls.
 * Also drives the approval-learning promotion: if Dredd asked the user
 * about this tool call and the user accepted, the matching PostToolUse
 * arrival here is our only positive signal — promote the pending
 * candidate to a durable approval.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  tracker,
  approvals,
  readBody,
  json,
  rejectInvalidSessionId,
  authenticateHookRequest,
} from "../server-core.js";
import { consumePendingApproval } from "../pending-approvals.js";

export async function handleTrack(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id, tool_name, tool_input, tool_output } = body;
  // Correlates with the tool_use_id sent on /evaluate. Used to look up
  // a pending approval and promote it to a durable entry — the
  // PostToolUse arrival is our only signal that the user accepted the
  // prompt Dredd asked them about.
  const tool_use_id: string | null = body.tool_use_id ?? null;

  if (rejectInvalidSessionId(res, session_id)) return;
  if (!tool_name) {
    return json(res, 400, { error: "Missing tool_name" });
  }

  if (tool_name === "Read") {
    await tracker.recordFileRead(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_output ?? "")
    );
  }

  if (tool_name === "Write") {
    await tracker.recordFileWrite(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_input?.content ?? ""),
      false
    );
  }

  if (tool_name === "Edit") {
    await tracker.recordFileWrite(
      session_id,
      String(tool_input?.file_path ?? ""),
      String(tool_input?.new_string ?? ""),
      true
    );
  }

  if (tool_name === "Bash") {
    await tracker.recordEnvVar(session_id, String(tool_input?.command ?? ""));
  }

  // Approval-learning promotion. Only fires when /evaluate stashed a
  // pending candidate against this tool_use_id (i.e. Dredd returned
  // permissionDecision="ask" and the user accepted — the tool wouldn't
  // be running otherwise). Best-effort: any failure logs and continues
  // without blocking the tracking response.
  if (tool_use_id) {
    const pending = consumePendingApproval(session_id, tool_use_id);
    if (pending) {
      try {
        const projectRoot = await tracker.getProjectRoot(session_id);
        const { ownerSub, ownerEmail } = await tracker.getSessionOwner(session_id);
        if (projectRoot && ownerSub) {
          await approvals.recordApproval({
            scope: { ownerSub, projectRoot },
            ownerEmail,
            fingerprintHash: pending.fingerprintHash,
            fingerprintJson: pending.fingerprintJson,
            summary: pending.summary,
            tool: pending.tool,
            intentSnapshot: pending.intentSnapshot,
            goalEmbedding: pending.goalEmbedding,
          });
          console.log(
            `  [${session_id.substring(0, 8)}] [APPRV] learned: ${pending.summary}`,
          );
        }
      } catch (err) {
        console.warn(
          `  [${session_id.substring(0, 8)}] [APPRV] failed to record approval:`,
          (err as Error)?.message ?? err,
        );
      }
    }
  }

  json(res, 200, {});
}
