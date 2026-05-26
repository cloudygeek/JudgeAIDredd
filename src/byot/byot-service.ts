// src/byot/byot-service.ts
import type { ByotStore } from "../byot-store.js";
import type { ByotCrypto } from "./byot-crypto.js";
import type { ByotConfigRecord, ByotConfigStatusView } from "./types.js";
import { probeRegionCapabilities, type ProbeResult } from "./capability-probe.js";

export interface ByotServiceOptions {
  store: ByotStore;
  crypto: ByotCrypto;
  models: { judgeModel: string; embeddingModel: string };
  /** Invalidate the hot-path provider cache on write/delete (optional —
   *  the dashboard container and hook container are separate processes,
   *  so this only matters in a single-process/dev deployment). */
  onChange?: (ownerSub: string) => void;
}

export class ByotService {
  constructor(private readonly opts: ByotServiceOptions) {}

  async getStatus(ownerSub: string): Promise<ByotConfigStatusView> {
    const r = await this.opts.store.get(ownerSub);
    if (!r) return { configured: false };
    return {
      configured: true,
      provider: r.provider,
      region: r.region,
      last4: r.last4,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastValidatedAt: r.lastValidatedAt,
      lastFallbackAt: r.lastFallbackAt ?? null,
      lastFallbackReason: r.lastFallbackReason ?? null,
    };
  }

  /** Validate the token against every model in the chosen region, then
   *  encrypt + store. Returns the probe result; on failure nothing is
   *  stored. */
  async validateAndStore(
    ownerSub: string,
    token: string,
    region: string,
  ): Promise<{ stored: boolean; probe: ProbeResult }> {
    const probe = await probeRegionCapabilities(token, region, this.opts.models);
    if (!probe.ok) return { stored: false, probe };

    const now = new Date().toISOString();
    // Read-modify-write (get → put) to preserve the original createdAt. Not
    // atomic, but acceptable for a per-user config row: last-writer-wins and
    // any createdAt skew between concurrent saves is inconsequential.
    const existing = await this.opts.store.get(ownerSub);
    const ciphertext = await this.opts.crypto.encrypt(token, { ownerSub });
    const record: ByotConfigRecord = {
      ownerSub,
      provider: "bedrock-bearer",
      region,
      ciphertext,
      last4: token.slice(-4),
      status: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastValidatedAt: now,
      lastFallbackAt: null,
      lastFallbackReason: null,
    };
    await this.opts.store.put(record);
    this.opts.onChange?.(ownerSub);
    return { stored: true, probe };
  }

  async remove(ownerSub: string): Promise<void> {
    await this.opts.store.delete(ownerSub);
    this.opts.onChange?.(ownerSub);
  }
}
