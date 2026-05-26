// src/byot-store.ts
import type { ByotConfigRecord, ByotConfigStatus } from "./byot/types.js";

/** Per-user store of the encrypted Bedrock token config. One row per
 *  ownerSub. The store treats `ciphertext` as opaque — crypto lives in
 *  ByotCrypto. See terraform/jaid-byot.tf. */
export interface ByotStore {
  get(ownerSub: string): Promise<ByotConfigRecord | null>;
  put(record: ByotConfigRecord): Promise<void>;
  delete(ownerSub: string): Promise<void>;
  /** Stamp a runtime auth failure onto the record (status +
   *  lastFallbackAt/Reason) without touching the ciphertext. */
  markRuntimeFallback(ownerSub: string, reason: string, at: string): Promise<void>;
}

export class InMemoryByotStore implements ByotStore {
  private readonly rows = new Map<string, ByotConfigRecord>();
  async get(ownerSub: string): Promise<ByotConfigRecord | null> {
    return this.rows.get(ownerSub) ?? null;
  }
  async put(record: ByotConfigRecord): Promise<void> {
    this.rows.set(record.ownerSub, { ...record });
  }
  async delete(ownerSub: string): Promise<void> {
    this.rows.delete(ownerSub);
  }
  async markRuntimeFallback(ownerSub: string, reason: string, at: string): Promise<void> {
    const r = this.rows.get(ownerSub);
    if (!r) return;
    const status: ByotConfigStatus = "runtime-fallback";
    this.rows.set(ownerSub, { ...r, status, lastFallbackAt: at, lastFallbackReason: reason, updatedAt: at });
  }
}
