/**
 * Write-through LRU cache wrapping an `ApprovalStore`.
 *
 * `lookup()` fires on every PreToolUse — the hottest path Dredd has.
 * A Dynamo `GetItem` per call would add a real round-trip to every
 * tool evaluation. Cache it.
 *
 * Two TTLs:
 *   - positive: known-good hit, 5m. Long enough that bursty sessions
 *     don't repeatedly re-read; short enough that revocations land
 *     within minutes.
 *   - negative: known-miss tombstone, 30s. Stops a session that keeps
 *     issuing un-approved tool calls from hammering Dynamo with the
 *     same negative lookup.
 *
 * Revocation:
 *   - Local container invalidates immediately on `revoke`.
 *   - Other containers stay stale up to the positive TTL.
 *
 * useCount / lastUsedAt:
 *   - `touchLastUsed` is fire-and-forget against the backend. We don't
 *     refresh the cache entry's timestamps; they're for display, not
 *     security, and the cache will reload from the backend within
 *     positive TTL.
 */

import {
  type ApprovalStore,
  type ApprovalScope,
  type ApprovalRecord,
  type RecordApprovalInput,
} from "./approval-store.js";

const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const DEFAULT_MAX = 2000;

interface CacheEntry {
  record: ApprovalRecord | null; // null = tombstone
  expiresAt: number;
}

export interface CachedApprovalStoreOptions {
  backend: ApprovalStore;
  maxEntries?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

function cacheKey(scope: ApprovalScope, fingerprintHash: string): string {
  return `${scope.ownerSub}|${scope.projectRoot}|${fingerprintHash}`;
}

export class CachedApprovalStore implements ApprovalStore {
  private readonly backend: ApprovalStore;
  private readonly maxEntries: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: CachedApprovalStoreOptions) {
    this.backend = opts.backend;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX;
    this.positiveTtlMs = opts.positiveTtlMs ?? POSITIVE_TTL_MS;
    this.negativeTtlMs = opts.negativeTtlMs ?? NEGATIVE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private readCached(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  async recordApproval(input: RecordApprovalInput): Promise<ApprovalRecord> {
    const record = await this.backend.recordApproval(input);
    this.touch(cacheKey(input.scope, input.fingerprintHash), {
      record,
      expiresAt: this.now() + this.positiveTtlMs,
    });
    return record;
  }

  async lookup(scope: ApprovalScope, fingerprintHash: string): Promise<ApprovalRecord | null> {
    const k = cacheKey(scope, fingerprintHash);
    const cached = this.readCached(k);
    if (cached) return cached.record;

    const record = await this.backend.lookup(scope, fingerprintHash);
    this.touch(k, {
      record,
      expiresAt: this.now() + (record ? this.positiveTtlMs : this.negativeTtlMs),
    });
    return record;
  }

  async touchLastUsed(scope: ApprovalScope, fingerprintHash: string): Promise<void> {
    // Fire-and-forget; cache entry's display fields stay stale until
    // positive TTL refresh. The backend write is what matters.
    return this.backend.touchLastUsed(scope, fingerprintHash);
  }

  async listByOwner(ownerSub: string, limit?: number): Promise<ApprovalRecord[]> {
    return this.backend.listByOwner(ownerSub, limit);
  }

  async listAll(limit?: number): Promise<ApprovalRecord[]> {
    return this.backend.listAll(limit);
  }

  async revoke(scope: ApprovalScope, fingerprintHash: string, revokedBy: string): Promise<boolean> {
    const ok = await this.backend.revoke(scope, fingerprintHash, revokedBy);
    // Invalidate locally; remote containers stay stale up to positive TTL.
    this.cache.delete(cacheKey(scope, fingerprintHash));
    return ok;
  }
}
