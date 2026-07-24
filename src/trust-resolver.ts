import type { TrustStore } from "./trust-store.js";

interface CacheEntry { trusted: boolean; expiresAt: number; }

export interface TrustResolverOptions {
  store: TrustStore;
  /** Trusted-boolean cache TTL. Default 5 min. */
  cacheTtlMs?: number;
  /** Override for tests. */
  now?: () => number;
}

/** Resolves whether an owner is trusted on the hot path. Caches the boolean
 *  in-process so /evaluate doesn't hit Dynamo every call. Fails soft to
 *  `false` (not-trusted) on any store error — a trust outage costs a judge
 *  call, never an accidental allow-all. */
export class TrustResolver {
  private readonly store: TrustStore;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: TrustResolverOptions) {
    this.store = opts.store;
    this.ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  invalidate(ownerSub: string): void {
    this.cache.delete(ownerSub);
  }

  async isTrusted(ownerSub: string | null | undefined): Promise<boolean> {
    if (!ownerSub) return false;
    const cached = this.cache.get(ownerSub);
    if (cached && cached.expiresAt > this.now()) return cached.trusted;
    let trusted = false;
    try {
      const rec = await this.store.get(ownerSub);
      trusted = !!(rec && rec.enabled);
    } catch (err) {
      console.warn(`[trust] resolve failed for ${ownerSub.substring(0, 8)}: ${(err as Error)?.message ?? err}`);
      trusted = false;
    }
    this.cache.set(ownerSub, { trusted, expiresAt: this.now() + this.ttl });
    return trusted;
  }
}
