/** Per-user "trust" flag: an admin-granted judge bypass. One row per
 *  ownerSub, stored as a sk=TRUST item on the jaid-byot table (see
 *  server-core.ts wiring). Holds no secret — plaintext boolean + audit
 *  metadata, so no KMS. */
export interface TrustRecord {
  ownerSub: string;
  enabled: boolean;
  /** Clerk userId of the admin who set it. */
  setBy: string;
  /** Admin's email if Clerk surfaced one. */
  setByEmail: string | null;
  /** ISO timestamp of the last change. */
  setAt: string;
  /** Free-text reason (optional). */
  note?: string | null;
}

export interface TrustStore {
  get(ownerSub: string): Promise<TrustRecord | null>;
  put(record: TrustRecord): Promise<void>;
  delete(ownerSub: string): Promise<void>;
}

export class InMemoryTrustStore implements TrustStore {
  private readonly rows = new Map<string, TrustRecord>();
  async get(ownerSub: string): Promise<TrustRecord | null> {
    return this.rows.get(ownerSub) ?? null;
  }
  async put(record: TrustRecord): Promise<void> {
    this.rows.set(record.ownerSub, { ...record });
  }
  async delete(ownerSub: string): Promise<void> {
    this.rows.delete(ownerSub);
  }
}

export type TrustToggleInput = { ownerSub: string; enabled: boolean; note: string | null };

/** Validate a POST /api/trust body. Pure — no I/O. */
export function parseTrustToggle(
  body: any,
): { ok: true; value: TrustToggleInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const ownerSub = typeof body.ownerSub === "string" ? body.ownerSub.trim() : "";
  if (!ownerSub) return { ok: false, error: "ownerSub is required" };
  if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  return { ok: true, value: { ownerSub, enabled: body.enabled, note } };
}
