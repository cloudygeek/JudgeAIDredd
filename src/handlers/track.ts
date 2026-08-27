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
  consumeRecentPermissionNotification,
  CONFIG,
} from "../server-core.js";
import { consumePendingApproval } from "../pending-approvals.js";
import { embedAny } from "../ollama-client.js";
import { DECISION_CAPTURE_ENABLED } from "../server-core.js";

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

  // Decision-capture path (PermissionDenied hook). The USER refused the
  // permission prompt, so the tool never ran. Record the refusal as the
  // call's outcome (paired by tool_use_id like the failure path) and drop
  // the pending approval WITHOUT promoting — a refusal is anti-consent.
  // Refusals never become ApprovalRecords: the approvals table feeds
  // trust signals and a "no" must not enter that pool. Flag-off is a
  // complete no-op so behaviour is byte-identical to pre-feature.
  if (body.user_decision === "deny") {
    if (!DECISION_CAPTURE_ENABLED) return json(res, 200, {});
    try {
      await tracker.recordUserDeny(
        session_id,
        tool_name,
        (tool_input ?? {}) as Record<string, unknown>,
        tool_use_id,
        String(body.deny_reason ?? ""),
      );
    } catch (err) {
      console.warn(
        `  [${session_id.substring(0, 8)}] [DECISION] recordUserDeny failed:`,
        (err as Error)?.message ?? err,
      );
    }
    if (tool_use_id) consumePendingApproval(session_id, tool_use_id);
    return json(res, 200, {});
  }

  // PostToolUseFailure path. The tool was allowed at PreToolUse but failed
  // at runtime. We DON'T run the file/env accumulation below — those side
  // effects never happened (no file written, no env exported) — and we
  // DON'T promote a pending approval, because a failure is not user
  // consent. We DO record the failure so the judge's recentTools and the
  // dashboard surface this call's outcome (repeated failed exec/egress is
  // probing behaviour). Best-effort: never block the /track response.
  if (body.is_error === true) {
    try {
      await tracker.recordToolFailure(
        session_id,
        tool_name,
        (tool_input ?? {}) as Record<string, unknown>,
        tool_use_id,
        String(body.tool_error ?? ""),
      );
    } catch (err) {
      console.warn(
        `  [${session_id.substring(0, 8)}] [FAIL] recordToolFailure failed:`,
        (err as Error)?.message ?? err,
      );
    }
    // Drop the pending approval candidate without promoting it — the user
    // never consented to a call that errored. Leaving it would let the
    // NEXT (successful) call with a stale id promote against this failure.
    if (tool_use_id) consumePendingApproval(session_id, tool_use_id);
    return json(res, 200, {});
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

  // Approval-learning promotion. Two flows funnel into the same record:
  //
  //   explicit — /evaluate returned "ask" and the user accepted; the
  //     PostToolUse arrival here is itself proof of consent.
  //
  //   tacit (Phase 9) — /evaluate returned "allow" but Claude Code
  //     surfaced its own permission prompt. We only promote when a
  //     permission-style /notification arrived for this session in
  //     the recent window — otherwise we can't tell whether the
  //     tool was auto-allowed (no consent to capture) or the user
  //     actively clicked Yes.
  //
  // Best-effort: any failure logs and continues without blocking the
  // tracking response.
  if (tool_use_id) {
    const pending = consumePendingApproval(session_id, tool_use_id);
    if (pending) {
      const source: "explicit" | "tacit" = pending.source ?? "explicit";

      // Tacit gating: require a recent permission-style notification.
      // If none, the tool was almost certainly auto-allowed by Claude
      // Code's user permissions; no consent to record.
      let shouldPromote = true;
      if (source === "tacit") {
        const lastN = consumeRecentPermissionNotification(session_id);
        if (!lastN) {
          shouldPromote = false;
        }
      }

      if (shouldPromote) {
        try {
          const projectRoot = await tracker.getProjectRoot(session_id);
          const { ownerSub, ownerEmail } = await tracker.getSessionOwner(session_id);
          if (projectRoot && ownerSub) {
            // Phase 8a — embed the (tool, input) JSON so future /evaluate
            // calls can find pattern-similar prior approvals. Best-effort:
            // an embed failure stores `[]` and the approval still lands
            // (just won't contribute to pattern-trust matching).
            let inputEmbedding: number[] = [];
            try {
              const embedText = JSON.stringify({ tool: pending.tool, input: pending.fingerprintJson });
              const vecs = await embedAny(embedText, CONFIG.embeddingModel);
              if (vecs?.[0]?.length) inputEmbedding = vecs[0];
            } catch (err) {
              console.warn(
                `  [${session_id.substring(0, 8)}] [APPRV] inputEmbedding failed (storing []): ${(err as Error)?.message ?? err}`,
              );
            }
            await approvals.recordApproval({
              scope: { ownerSub, projectRoot },
              ownerEmail,
              fingerprintHash: pending.fingerprintHash,
              fingerprintJson: pending.fingerprintJson,
              summary: pending.summary,
              tool: pending.tool,
              intentSnapshot: pending.intentSnapshot,
              goalEmbedding: pending.goalEmbedding,
              inputEmbedding,
              source,
              // Decision capture — label the consent kind. Tacit = the
              // user accepted a native prompt; explicit = accepted a
              // Dredd ask. "allow-always" arrives later via the
              // snapshot-diff upgrade, never from this path.
              ...(DECISION_CAPTURE_ENABLED
                ? {
                    decision: (source === "tacit" ? "allow-tacit" : "allow-once") as
                      | "allow-tacit"
                      | "allow-once",
                    decidedVia: "posttooluse" as const,
                  }
                : {}),
            });
            console.log(
              `  [${session_id.substring(0, 8)}] [APPRV] learned (${source}): ${pending.summary}` +
              (inputEmbedding.length ? ` (+${inputEmbedding.length}-dim embedding)` : ""),
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
  }

  json(res, 200, {});
}
