/**
 * Approval store.
 *
 * "Learning" layer for interactive-mode trust. When Dredd asks the user
 * about a tool call and the user accepts, we record the fingerprint of
 * that tool call against (ownerSub, projectRoot). The next time the
 * same fingerprint appears we short-circuit the three-stage pipeline
 * and auto-allow — saving the user from re-consenting to the same
 * action over and over.
 *
 * Three implementations, same interface (mirrors `ApiKeyStore`):
 *   - `InMemoryApprovalStore` — process-local Map, for local dev.
 *   - `DynamoApprovalStore`   — durable storage in `jaid-approvals`.
 *   - `CachedApprovalStore`   — write-through LRU wrapper.
 *
 * Scope: per-Clerk-userId AND per-projectRoot. Approvals don't cross
 * users (ownerSub) and don't cross projects (an approval granted while
 * working in ~/foo doesn't fire in ~/bar). Across sessions within that
 * scope, yes — that's the whole point.
 *
 * Safety invariants:
 *   - Raw secrets are NEVER stored. The curl fingerprinter hashes the
 *     Authorization token before it ever reaches this layer.
 *   - Hard policy denies (DENIED_BASH_PATTERNS, dangerous combos) and
 *     hijack-locked sessions are checked BEFORE the approval lookup —
 *     no approval can override the safety floor.
 *   - Intent drift snapshotted at approval time; lookups reject if the
 *     session has drifted far from the original consenting intent.
 */

// ---- types -----------------------------------------------------------------

/** Composite scope: same user, same project. */
export interface ApprovalScope {
  ownerSub: string;
  projectRoot: string;
}

/** What we persist per approval. */
export interface ApprovalRecord {
  /** sha256(stable-JSON(fingerprint shape)) — primary identifier within scope. */
  fingerprintHash: string;
  /** Human-readable one-liner for the dashboard, e.g.
   *  "curl to api.stripe.com with API key 4f3a…". Never contains secrets. */
  summary: string;
  /** Raw fingerprint JSON for audit/debugging. */
  fingerprintJson: string;
  /** Tool name, e.g. "Bash", "Edit", "WebFetch". */
  tool: string;

  ownerSub: string;
  ownerEmail: string | null;
  projectRoot: string;

  grantedAt: string;
  /** Refreshed on every hit; drives the 30-day TTL. */
  lastUsedAt: string;
  useCount: number;
  /** lastUsedAt + 30d, ISO. Dynamo TTL uses the epoch-seconds form. */
  expiresAt: string;

  /** User prompt active at approval time (for the dashboard's UI). */
  intentSnapshot: string;
  /** Goal embedding snapshot for the intent-drift backstop. Cosine
   *  distance > APPROVAL_INTENT_DRIFT_THRESHOLD at lookup time rejects
   *  the approval even though the fingerprint matches. */
  goalEmbedding: number[];
  /** Phase 8a — embedding of `tool + JSON(toolInput)` at consent time.
   *  Drives the pattern-trust learning in Phase 8b/c: similarity of the
   *  current /evaluate call against this vector decides whether the
   *  judge gets prior-approval context (soft) and whether enough
   *  similar prior approvals short-circuit the pipeline (hard).
   *  Empty array `[]` for legacy records written before this field
   *  existed — those rows fall through to the existing fingerprint
   *  match path. */
  inputEmbedding: number[];
  /** Phase 9 — how the approval was captured.
   *
   *  "explicit"     — user clicked Allow on a Dredd-surfaced "ask" prompt.
   *                   Strong consent. Eligible for the Stage 0.5 hard
   *                   short-circuit (overrides Dredd policy denies).
   *  "tacit"        — user clicked Yes on a Claude Code-native prompt
   *                   while Dredd had already said allow. We infer this
   *                   via Notification-timing correlation (see Phase 9
   *                   in CLAUDE.md). Weaker consent: contributes to
   *                   the soft signal (judge prompt context) and can
   *                   still drive Stage 1.75 approval-allow, but does
   *                   NOT override Stage 1 policy deny via Stage 0.5.
   *
   *  Optional for backwards compat — legacy rows written before this
   *  field existed are treated as "explicit" (the only path that
   *  recorded approvals before Phase 9). */
  source?: "explicit" | "tacit";

  /** Decision capture (plan-consent-completion phase 1) — the user's
   *  actual choice, when DREDD_DECISION_CAPTURE_ENABLED was on at
   *  promotion time. "allow-once" = accepted a Dredd ask; "allow-tacit"
   *  = accepted a native prompt (Phase 9 correlation); "allow-always"
   *  = a matching rule appeared in the user's permissions snapshot
   *  shortly after promotion (upgraded post-hoc). Absent on legacy rows
   *  and while the flag is off. Telemetry only — no lookup semantics. */
  decision?: "allow-once" | "allow-tacit" | "allow-always";
  /** How `decision` was determined: the promotion path itself, or the
   *  later user-permissions snapshot diff that upgraded it. */
  decidedVia?: "posttooluse" | "snapshot-diff";

  /** Set when revoked from the dashboard. Active records have null. */
  revokedAt: string | null;
  revokedBy: string | null;
}

/** Input to `recordApproval` — everything except server-set timestamps. */
export interface RecordApprovalInput {
  scope: ApprovalScope;
  ownerEmail: string | null;
  fingerprintHash: string;
  fingerprintJson: string;
  summary: string;
  tool: string;
  intentSnapshot: string;
  goalEmbedding: number[];
  /** Phase 8a — see ApprovalRecord.inputEmbedding. Callers compute
   *  this via embedAny(JSON({tool,input})) just before recordApproval.
   *  Pass [] if the embed call failed; the row is still persisted but
   *  won't contribute to pattern-trust matching. */
  inputEmbedding: number[];
  /** Phase 9 — see ApprovalRecord.source. Defaults to "explicit" when
   *  omitted to keep existing callers working unchanged. */
  source?: "explicit" | "tacit";
  /** Decision capture — see ApprovalRecord.decision/decidedVia. Omitted
   *  (flag off / legacy callers) stores nothing. */
  decision?: "allow-once" | "allow-tacit" | "allow-always";
  decidedVia?: "posttooluse" | "snapshot-diff";
}

export interface ApprovalStore {
  /** Persist an approval. The PostToolUse arrival is our trigger to
   *  promote a pending in-memory candidate to a durable record. If a
   *  record with the same (scope, fingerprintHash) already exists,
   *  refreshes its lastUsedAt/expiresAt and increments useCount. */
  recordApproval(input: RecordApprovalInput): Promise<ApprovalRecord>;

  /** Look up by (scope, fingerprintHash). Returns null when no live
   *  record exists (missing or revoked). Pure read — does NOT bump
   *  lastUsedAt; use `touchLastUsed` for that, called after the
   *  intent-drift check passes. */
  lookup(scope: ApprovalScope, fingerprintHash: string): Promise<ApprovalRecord | null>;

  /** Side-effect call after a successful approval-allow: bump useCount,
   *  refresh lastUsedAt + expiresAt. Fire-and-forget from callers. */
  touchLastUsed(scope: ApprovalScope, fingerprintHash: string): Promise<void>;

  /** Dashboard listing — newest first, excludes revoked. */
  listByOwner(ownerSub: string, limit?: number): Promise<ApprovalRecord[]>;

  /** Admin listing — every owner. Best-effort ordering. */
  listAll(limit?: number): Promise<ApprovalRecord[]>;

  /** Phase 8a — list every LIVE (non-revoked, non-expired) approval
   *  for one (ownerSub, projectRoot). Hot path: called on every
   *  /evaluate that has pattern-trust enabled to compute embedding
   *  similarity against the incoming tool call. Implementations must
   *  exclude revoked rows. limit defaults to 200 — well above the
   *  expected steady-state of approvals per project. */
  listForScope(scope: ApprovalScope, limit?: number): Promise<ApprovalRecord[]>;

  /** Decision capture — relabel an approval's decision post-hoc (the
   *  allow-always snapshot-diff upgrade). Returns false when no live
   *  record exists. Telemetry only: MUST NOT touch lastUsedAt/useCount
   *  or lookup semantics. */
  updateDecision(
    scope: ApprovalScope,
    fingerprintHash: string,
    decision: "allow-once" | "allow-tacit" | "allow-always",
    decidedVia: "posttooluse" | "snapshot-diff",
  ): Promise<boolean>;

  /** Soft-revoke. Sets revokedAt/revokedBy; returns true if a live
   *  record was found and revoked, false otherwise. */
  revoke(scope: ApprovalScope, fingerprintHash: string, revokedBy: string): Promise<boolean>;
}

// ---- in-memory implementation ---------------------------------------------

/** Composite key for the in-memory Map. */
function recordKey(scope: ApprovalScope, fingerprintHash: string): string {
  return `${scope.ownerSub}|${scope.projectRoot}|${fingerprintHash}`;
}

/** 30 days in milliseconds — the TTL window for an approval. Refreshed
 *  on every hit, so an approval used weekly stays alive indefinitely. */
export const APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Cosine-distance threshold above which a session's current intent is
 *  considered too far from the original approving intent. Set high
 *  enough that legitimate clarifications don't invalidate but low
 *  enough that a goal pivot does. Tune in production. */
export const APPROVAL_INTENT_DRIFT_THRESHOLD = 0.4;

export class InMemoryApprovalStore implements ApprovalStore {
  private records = new Map<string, ApprovalRecord>();

  async recordApproval(input: RecordApprovalInput): Promise<ApprovalRecord> {
    const key = recordKey(input.scope, input.fingerprintHash);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();

    const existing = this.records.get(key);
    if (existing && !existing.revokedAt) {
      existing.lastUsedAt = now;
      existing.useCount += 1;
      existing.expiresAt = expiresAt;
      return existing;
    }

    const record: ApprovalRecord = {
      fingerprintHash: input.fingerprintHash,
      summary: input.summary,
      fingerprintJson: input.fingerprintJson,
      tool: input.tool,
      ownerSub: input.scope.ownerSub,
      ownerEmail: input.ownerEmail,
      projectRoot: input.scope.projectRoot,
      grantedAt: now,
      lastUsedAt: now,
      useCount: 1,
      expiresAt,
      intentSnapshot: input.intentSnapshot,
      goalEmbedding: input.goalEmbedding,
      inputEmbedding: input.inputEmbedding ?? [],
      source: input.source ?? "explicit",
      ...(input.decision ? { decision: input.decision, decidedVia: input.decidedVia } : {}),
      revokedAt: null,
      revokedBy: null,
    };
    this.records.set(key, record);
    return record;
  }

  async lookup(scope: ApprovalScope, fingerprintHash: string): Promise<ApprovalRecord | null> {
    const record = this.records.get(recordKey(scope, fingerprintHash));
    if (!record) return null;
    if (record.revokedAt) return null;
    if (new Date(record.expiresAt).getTime() < Date.now()) return null;
    return record;
  }

  async touchLastUsed(scope: ApprovalScope, fingerprintHash: string): Promise<void> {
    const record = this.records.get(recordKey(scope, fingerprintHash));
    if (!record || record.revokedAt) return;
    record.lastUsedAt = new Date().toISOString();
    record.useCount += 1;
    record.expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  }

  async listByOwner(ownerSub: string, limit = 200): Promise<ApprovalRecord[]> {
    const out: ApprovalRecord[] = [];
    for (const r of this.records.values()) {
      if (r.ownerSub !== ownerSub) continue;
      if (r.revokedAt) continue;
      out.push(r);
    }
    out.sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
    return out.slice(0, limit);
  }

  async listAll(limit = 500): Promise<ApprovalRecord[]> {
    const out: ApprovalRecord[] = [];
    for (const r of this.records.values()) {
      if (r.revokedAt) continue;
      out.push(r);
    }
    out.sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
    return out.slice(0, limit);
  }

  async listForScope(scope: ApprovalScope, limit = 200): Promise<ApprovalRecord[]> {
    const now = Date.now();
    const out: ApprovalRecord[] = [];
    for (const r of this.records.values()) {
      if (r.ownerSub !== scope.ownerSub) continue;
      if (r.projectRoot !== scope.projectRoot) continue;
      if (r.revokedAt) continue;
      if (new Date(r.expiresAt).getTime() < now) continue;
      out.push(r);
    }
    out.sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
    return out.slice(0, limit);
  }

  async revoke(scope: ApprovalScope, fingerprintHash: string, revokedBy: string): Promise<boolean> {
    const record = this.records.get(recordKey(scope, fingerprintHash));
    if (!record || record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    record.revokedBy = revokedBy;
    return true;
  }

  async updateDecision(
    scope: ApprovalScope,
    fingerprintHash: string,
    decision: "allow-once" | "allow-tacit" | "allow-always",
    decidedVia: "posttooluse" | "snapshot-diff",
  ): Promise<boolean> {
    const record = this.records.get(recordKey(scope, fingerprintHash));
    if (!record || record.revokedAt) return false;
    record.decision = decision;
    record.decidedVia = decidedVia;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Decision capture — allow-always detection (plan-consent-completion §1.2).
// ---------------------------------------------------------------------------

/** grantedAt window inside which a newly-added user allow rule is taken
 *  as the "always" form of a just-promoted approval. Deliberately loose
 *  v1 matching (tool name + time window, not rule-pattern-to-input): the
 *  label is telemetry, and a false "always" costs nothing at lookup. */
export const ALLOW_ALWAYS_WINDOW_MS = 10 * 60 * 1000;

/** Tool a Claude Code permission rule applies to: "Bash(curl:*)" → "Bash",
 *  bare "Read" → "Read", MCP names pass through whole. */
export function ruleToolOf(rule: string): string {
  const i = rule.indexOf("(");
  return (i === -1 ? rule : rule.slice(0, i)).trim();
}

/**
 * Upgrade approvals promoted within the window to "allow-always" when the
 * user's permissions snapshot gained a rule for the same tool. Called from
 * /intent when a changed snapshot arrives (rare path — full payloads only
 * ship on hash change or heartbeat). Best-effort by contract: callers
 * wrap in try/catch; a store blip loses a label, never a behaviour.
 * Returns the number of records upgraded.
 */
export async function upgradeRecentApprovalsToAlways(
  store: ApprovalStore,
  scope: ApprovalScope,
  addedAllowRules: string[],
  windowMs: number = ALLOW_ALWAYS_WINDOW_MS,
): Promise<number> {
  if (addedAllowRules.length === 0) return 0;
  const addedTools = new Set(addedAllowRules.map(ruleToolOf).filter((t) => t.length > 0));
  if (addedTools.size === 0) return 0;

  const cutoff = Date.now() - windowMs;
  const recent = (await store.listForScope(scope)).filter(
    (r) =>
      !r.revokedAt &&
      r.decision !== "allow-always" &&
      new Date(r.grantedAt).getTime() >= cutoff &&
      addedTools.has(r.tool),
  );

  let upgraded = 0;
  for (const r of recent) {
    if (await store.updateDecision(scope, r.fingerprintHash, "allow-always", "snapshot-diff")) {
      upgraded++;
    }
  }
  return upgraded;
}
