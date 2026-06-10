/**
 * POST /instructions — InstructionsLoaded hook handler.
 *
 * Records a CLAUDE.md / .claude/rules/*.md file entering the agent's
 * context. Instruction files are a goal-hijack channel the judge can't
 * otherwise see (it runs in clean context), so we track each load against
 * the session. When DREDD_INSTRUCTIONS_EVIDENCE_ENABLED is on, /evaluate
 * folds these into the judge prompt as soft evidence; recording happens
 * regardless of the flag so the signal is available to soak.
 *
 * Fire-and-forget from the hook's perspective — best-effort, never blocks.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  tracker,
  readBody,
  json,
  rejectInvalidSessionId,
  authenticateHookRequest,
} from "../server-core.js";

export async function handleInstructions(req: IncomingMessage, res: ServerResponse) {
  const identity = await authenticateHookRequest(req, res);
  if (!identity) return;

  const body = JSON.parse(await readBody(req));
  const { session_id } = body;
  // Claude Code's InstructionsLoaded payload carries file_path + load_reason.
  const filePath: string = String(body.file_path ?? "");
  const loadReason: string = String(body.load_reason ?? "");

  if (rejectInvalidSessionId(res, session_id)) return;
  if (!filePath) {
    return json(res, 400, { error: "Missing file_path" });
  }

  try {
    await tracker.recordInstructionLoad(session_id, filePath, loadReason);
  } catch (err) {
    // Best-effort: a record failure must never break the hook.
    console.warn(
      `  [${session_id.substring(0, 8)}] [INSTR] recordInstructionLoad failed:`,
      (err as Error)?.message ?? err,
    );
  }

  json(res, 200, {});
}
