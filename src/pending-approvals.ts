/**
 * Pending approvals — the missing-piece between Dredd asking and the
 * user deciding.
 *
 * Two flows feed the same map:
 *
 *  A. **Explicit** — /evaluate returned permissionDecision="ask".
 *     Dredd surfaced its own reason in the prompt; the user accepted.
 *     PostToolUse arrives and we promote with source="explicit".
 *
 *  B. **Tacit** (Phase 9) — /evaluate returned permissionDecision="allow"
 *     but Claude Code still surfaced a native permission prompt because
 *     the user's local Claude settings required it (e.g. Bash not in
 *     their allowlist). We can't see the prompt, but a /notification
 *     event arrives between /evaluate and /track. When that notification
 *     looks like a permission ask, we infer the user clicked Yes and
 *     promote with source="tacit". Tacit approvals are weaker consent:
 *     they feed the soft pattern-trust signal but cannot override
 *     Dredd's hard policy denies (Stage 0.5 filters them out of the
 *     hard short-circuit count).
 *
 * This map is in-process / ephemeral on purpose. The 60-second TTL is
 * the worst-case "time from ask to user decision." Anything longer than
 * that and the user almost certainly cancelled the prompt anyway.
 *
 * Container restart between ask and PostToolUse loses pending state —
 * the same approval gets re-asked next time. Acceptable: we'd rather
 * re-prompt than silently auto-record an approval we can't verify.
 */

export interface PendingApproval {
  tool: string;
  fingerprintHash: string;
  fingerprintJson: string;
  summary: string;
  /** User prompt active at /evaluate time — frozen here so the approval
   *  record snapshots the exact intent the user was consenting under. */
  intentSnapshot: string;
  /** Goal embedding snapshot for the intent-drift backstop at lookup time. */
  goalEmbedding: number[];
  /** Phase 9 — which capture flow stashed this candidate. Drives the
   *  promotion path in /track: explicit promotes unconditionally,
   *  tacit promotes only if a permission-style notification arrived
   *  between /evaluate and /track. Defaults to "explicit" so existing
   *  callers behave unchanged. */
  source?: "explicit" | "tacit";
  /** Epoch ms — entries past this are ignored on consume. */
  expiresAt: number;
}

const PENDING_TTL_MS = 60_000;
const pendingMap = new Map<string, PendingApproval>();

function key(sessionId: string, toolUseId: string): string {
  return `${sessionId}|${toolUseId}`;
}

export function recordPendingApproval(
  sessionId: string,
  toolUseId: string,
  candidate: Omit<PendingApproval, "expiresAt">,
): void {
  pendingMap.set(key(sessionId, toolUseId), {
    ...candidate,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

/** Look up and remove a pending candidate. Returns null when absent or
 *  expired — both are treated the same by callers (don't promote). */
export function consumePendingApproval(
  sessionId: string,
  toolUseId: string,
): PendingApproval | null {
  const k = key(sessionId, toolUseId);
  const p = pendingMap.get(k);
  if (!p) return null;
  pendingMap.delete(k);
  if (p.expiresAt < Date.now()) return null;
  return p;
}

/** Janitor: drops expired candidates. Called from a periodic timer in
 *  server boot; safe to call from anywhere. */
export function pruneExpiredPendingApprovals(): number {
  const now = Date.now();
  let removed = 0;
  for (const [k, p] of pendingMap) {
    if (p.expiresAt < now) { pendingMap.delete(k); removed++; }
  }
  return removed;
}

/** Test/diagnostic helper. */
export function pendingApprovalCount(): number {
  return pendingMap.size;
}
