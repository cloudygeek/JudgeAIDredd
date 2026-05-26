// src/byot/credential-provider.ts
import type { BedrockAuth } from "./types.js";
import type { ByotStore } from "../byot-store.js";
import type { ByotCrypto } from "./byot-crypto.js";

export interface CredentialProvider {
  /** Resolve the BedrockAuth for a session owner. Always fails soft to
   *  {kind:"default"} — never throws — so a resolver problem can never
   *  break the hot path. */
  resolve(ownerSub: string | null | undefined): Promise<BedrockAuth>;
}

/** Used when DREDD_BYOT_ENABLED=false: every call runs on platform creds. */
export class DefaultCredentialProvider implements CredentialProvider {
  async resolve(): Promise<BedrockAuth> {
    return { kind: "default" };
  }
}

interface CacheEntry { auth: BedrockAuth; expiresAt: number; }

export interface BearerCredentialProviderOptions {
  store: ByotStore;
  crypto: ByotCrypto;
  /** Decrypted-auth cache TTL. Default 5 min (matches cached-api-key-store). */
  cacheTtlMs?: number;
  /** Override for tests. */
  now?: () => number;
}

/** Reads the per-user BYOT row, decrypts the token, returns a bearer
 *  BedrockAuth. Caches the *decrypted* auth in-process so we don't pay a
 *  KMS Decrypt on every /evaluate. */
export class BearerCredentialProvider implements CredentialProvider {
  private readonly store: ByotStore;
  private readonly crypto: ByotCrypto;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: BearerCredentialProviderOptions) {
    this.store = opts.store;
    this.crypto = opts.crypto;
    this.ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  invalidate(ownerSub: string): void {
    this.cache.delete(ownerSub);
  }

  async resolve(ownerSub: string | null | undefined): Promise<BedrockAuth> {
    if (!ownerSub) return { kind: "default" };
    const cached = this.cache.get(ownerSub);
    if (cached && cached.expiresAt > this.now()) return cached.auth;

    let auth: BedrockAuth = { kind: "default" };
    try {
      const rec = await this.store.get(ownerSub);
      if (rec && rec.provider === "bedrock-bearer") {
        const token = await this.crypto.decrypt(rec.ciphertext, { ownerSub });
        auth = { kind: "bearer", token, region: rec.region };
      }
    } catch (err) {
      // Decrypt / store error → fail soft to default. Logged, not thrown.
      console.warn(`[byot] resolve failed for ${ownerSub.substring(0, 8)}: ${(err as Error)?.message ?? err}`);
      auth = { kind: "default" };
    }
    this.cache.set(ownerSub, { auth, expiresAt: this.now() + this.ttl });
    return auth;
  }
}
