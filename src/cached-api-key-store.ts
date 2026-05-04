/**
 * Write-through LRU cache wrapping an `ApiKeyStore`.
 *
 * API keys are validated on EVERY hook request. That's potentially the
 * hottest path in the server — every tool call, every intent registration,
 * every /track, every /end. Doing a Dynamo `GetItem` for each would add
 * ~10ms p50 + a Dynamo read for every request. With a positive cache of a
 * few minutes we take the hit once per key per container and serve the
 * rest from memory.
 *
 * Two caches:
 *   - positive: validated hash → ValidatedKey, 5m TTL. Reverts to Dynamo
 *                after TTL so revocations eventually propagate.
 *   - negative: unknown hash → tombstone, 30s TTL. Stops an attacker from
 *                brute-forcing keys by ensuring each guess pays a Dynamo
 *                lookup at most once per 30s per hash.
 *
 * Revocation propagation:
 *   - The container that calls `revokeKey` invalidates its own cache
 *     immediately.
 *   - Other containers stay stale for up to 5 minutes (positive cache TTL).
 *     For the sandbox threat model this is acceptable; emergency revoke
 *     within 5 minutes is fine. If we need faster, we'd add an SNS fanout
 *     invalidation channel — out of scope for v1.
 *
 * lastUsedAt:
 *   - The backend updates lastUsedAt asynchronously on every `validateKey`.
 *     We don't bother reading it on cache hits (it's only for dashboard
 *     display, not for security decisions), so cache staleness is fine.
 */

import {
  type ApiKeyStore,
  type GenerateKeyInput,
  type GeneratedKey,
  type KeyRecord,
  type ValidatedKey,
  hashKey,
  looksLikeJaidKey,
} from "./api-key-store.js";

const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const DEFAULT_MAX = 1000;

interface CacheEntry {
  validated: ValidatedKey | null; // null = tombstone (known-unknown)
  expiresAt: number;
}

export interface CachedApiKeyStoreOptions {
  backend: ApiKeyStore;
  maxHashes?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  /** Override for tests. */
  now?: () => number;
}

export class CachedApiKeyStore implements ApiKeyStore {
  private readonly backend: ApiKeyStore;
  private readonly maxHashes: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;

  /** LRU-ordered by insertion / touch. JS `Map` iteration order = insertion
   *  order, so we delete-and-reinsert to mark as recently used. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: CachedApiKeyStoreOptions) {
    this.backend = opts.backend;
    this.maxHashes = opts.maxHashes ?? DEFAULT_MAX;
    this.positiveTtlMs = opts.positiveTtlMs ?? POSITIVE_TTL_MS;
    this.negativeTtlMs = opts.negativeTtlMs ?? NEGATIVE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  // ---- cache plumbing --------------------------------------------------

  private touch(hash: string, entry: CacheEntry): void {
    this.cache.delete(hash);
    this.cache.set(hash, entry);
    while (this.cache.size > this.maxHashes) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private readCached(hash: string): CacheEntry | undefined {
    const entry = this.cache.get(hash);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(hash);
      return undefined;
    }
    // Touch to bump LRU order.
    this.cache.delete(hash);
    this.cache.set(hash, entry);
    return entry;
  }

  private invalidate(hash: string): void {
    this.cache.delete(hash);
  }

  // ---- ApiKeyStore impl ------------------------------------------------

  async generateKey(input: GenerateKeyInput): Promise<GeneratedKey> {
    // Delegate to backend. Seed the positive cache so the very first
    // validation on this container doesn't round-trip.
    const gen = await this.backend.generateKey(input);
    this.touch(gen.hashedKey, {
      validated: {
        hashedKey: gen.hashedKey,
        ownerSub: gen.ownerSub,
        ownerEmail: gen.ownerEmail,
        keyType: gen.keyType,
      },
      expiresAt: this.now() + this.positiveTtlMs,
    });
    return gen;
  }

  async validateKey(plaintext: string): Promise<ValidatedKey | null> {
    // Fast reject on shape mismatch — no cache pollution.
    if (!looksLikeJaidKey(plaintext)) return null;
    const hash = hashKey(plaintext);

    const cached = this.readCached(hash);
    if (cached) return cached.validated; // may be null tombstone

    const result = await this.backend.validateKey(plaintext);
    this.touch(hash, {
      validated: result,
      expiresAt:
        this.now() + (result ? this.positiveTtlMs : this.negativeTtlMs),
    });
    return result;
  }

  async listByOwner(ownerSub: string, limit?: number): Promise<KeyRecord[]> {
    // Dashboard operation. Don't cache — always hit backend so the list
    // reflects freshly-generated or revoked keys. Low QPS anyway.
    return this.backend.listByOwner(ownerSub, limit);
  }

  async revokeKey(hashedKey: string, revokedBy: string): Promise<boolean> {
    const ok = await this.backend.revokeKey(hashedKey, revokedBy);
    // Invalidate immediately on this container. Other containers will hit
    // their own 5-minute positive-cache TTL before picking up the revoke.
    this.invalidate(hashedKey);
    return ok;
  }

  async loadKey(hashedKey: string): Promise<KeyRecord | null> {
    return this.backend.loadKey(hashedKey);
  }
}
