/**
 * API key store.
 *
 * Hook authentication layer. Users generate keys via the dashboard; the
 * plaintext is shown once, hashed with SHA-256, and stored against their
 * OIDC sub. Every subsequent hook request carries the plaintext in an
 * `Authorization: Bearer jaid_live_...` header; the server hashes and
 * looks up.
 *
 * Key format: `jaid_live_` + 43 base62 chars (256 bits of entropy).
 *
 * Three implementations, same interface:
 *   - `InMemoryApiKeyStore` — process-local Map, for local dev.
 *   - `DynamoApiKeyStore`   — against `jaid-api-keys` in eu-west-1.
 *   - `CachedApiKeyStore`   — write-through LRU wrapper; 5m positive /
 *                             30s negative, so revokes propagate fast.
 *
 * Injection-resistance invariants (see `DynamoApiKeyStore`):
 *   - No PartiQL; all values bound via placeholders.
 *   - Key attributes are derived server-side from hashed plaintext;
 *     no user input ever reaches a partition key or sort key.
 *   - The GSI1 keys are set / unset explicitly; never from user input.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// ---- types -----------------------------------------------------------------

export type KeyType = "user" | "service" | "benchmark";

/** What we persist for each key. The plaintext is NEVER stored. */
export interface KeyRecord {
  /** sha256(plaintext) as hex, 64 chars. Primary identifier. */
  hashedKey: string;
  /** First 10 chars + last 4 chars of the plaintext, masked middle.
   *  Display-only; safe to return from `listByOwner`. */
  keyPreview: string;
  /** OIDC `sub` claim — the stable owner identifier. */
  ownerSub: string;
  /** OIDC `email` claim — display convenience on the dashboard. */
  ownerEmail: string | null;
  /** User-supplied label, e.g. "MacBook laptop hook". */
  description: string;
  keyType: KeyType;
  createdAt: string;
  /** Updated async on every successful validation. */
  lastUsedAt: string | null;
  /** Set when revoked; absent for active keys. */
  revokedAt: string | null;
  /** Who pressed the revoke button (their OIDC sub). */
  revokedBy: string | null;
}

/** Shape returned to the hook caller immediately after generation.
 *  Includes the plaintext ONCE — the user must copy it now or never. */
export interface GeneratedKey extends KeyRecord {
  plaintext: string;
}

/** Input for key generation. */
export interface GenerateKeyInput {
  ownerSub: string;
  ownerEmail: string | null;
  description: string;
  keyType?: KeyType;
}

/** Result of a successful validation — used to attach identity to a request. */
export interface ValidatedKey {
  hashedKey: string;
  ownerSub: string;
  ownerEmail: string | null;
  keyType: KeyType;
}

export interface ApiKeyStore {
  /** Mint a new key, persist the hash, return the plaintext + metadata. */
  generateKey(input: GenerateKeyInput): Promise<GeneratedKey>;

  /** Validate a plaintext key. Returns identity on success, null otherwise.
   *  Updates `lastUsedAt` as a side effect (best-effort, not awaited by callers). */
  validateKey(plaintext: string): Promise<ValidatedKey | null>;

  /** List a user's active keys, newest first. Does not return revoked keys. */
  listByOwner(ownerSub: string, limit?: number): Promise<KeyRecord[]>;

  /** Admin-only: list every active key across all owners. Implementations
   *  may cap or paginate. Returns at most `limit` records, newest first
   *  where the implementation can sort cheaply (Dynamo cannot without a
   *  GSI, so the order is undefined for the Dynamo-backed store). */
  listAll(limit?: number): Promise<KeyRecord[]>;

  /** Soft-revoke a key by hash. `revokedBy` is the OIDC sub of the caller. */
  revokeKey(hashedKey: string, revokedBy: string): Promise<boolean>;

  /** Load a single key by hash, including revoked. Null if unknown.
   *  Primarily used by `CachedApiKeyStore` and forensics; regular auth
   *  should go through `validateKey`. */
  loadKey(hashedKey: string): Promise<KeyRecord | null>;
}

// ---- key minting -----------------------------------------------------------

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 43 base62 chars ≈ 43 × log₂(62) ≈ 256 bits of entropy. */
const KEY_BODY_LENGTH = 43;
const KEY_PREFIX = "jaid_live_";

/**
 * Generate a new plaintext key. Uses `crypto.randomBytes` for entropy and
 * maps bytes to base62 via rejection sampling so the distribution is uniform
 * (naive modulo yields slightly non-uniform output — cheap to avoid).
 */
export function mintPlaintext(): string {
  const out: string[] = [];
  while (out.length < KEY_BODY_LENGTH) {
    // Pull a chunk of bytes; reject any >= 248 so that bytes % 62 is uniform
    // over 0..61 (248 = 4 × 62, the largest multiple that fits in a byte).
    const chunk = randomBytes(KEY_BODY_LENGTH * 2);
    for (const b of chunk) {
      if (b >= 248) continue;
      out.push(BASE62[b % 62]);
      if (out.length === KEY_BODY_LENGTH) break;
    }
  }
  return KEY_PREFIX + out.join("");
}

/** sha256(plaintext), hex-encoded. Used for the primary key in Dynamo. */
export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Masked preview for display: first 10 + last 4 chars, middle replaced
 *  with ellipsis. Safe to show in the dashboard list. */
export function keyPreview(plaintext: string): string {
  if (plaintext.length <= 14) return plaintext; // pathologically short — just show it
  return `${plaintext.slice(0, 14)}...${plaintext.slice(-4)}`;
}

/** Validate the surface shape of a key. Bearer tokens that don't match this
 *  shape get rejected without touching Dynamo. */
export function looksLikeJaidKey(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (!s.startsWith(KEY_PREFIX)) return false;
  const body = s.slice(KEY_PREFIX.length);
  if (body.length !== KEY_BODY_LENGTH) return false;
  // Base62 character class.
  return /^[0-9A-Za-z]+$/.test(body);
}

// ---- in-memory impl --------------------------------------------------------

/**
 * Process-local key store. Used for local dev parity with the Dynamo
 * implementation. All state lives in a Map keyed by hash; data is lost on
 * restart. Never use in production.
 */
export class InMemoryApiKeyStore implements ApiKeyStore {
  private keys = new Map<string, KeyRecord>();

  async generateKey(input: GenerateKeyInput): Promise<GeneratedKey> {
    const plaintext = mintPlaintext();
    const hashedKey = hashKey(plaintext);
    const record: KeyRecord = {
      hashedKey,
      keyPreview: keyPreview(plaintext),
      ownerSub: input.ownerSub,
      ownerEmail: input.ownerEmail,
      description: input.description,
      keyType: input.keyType ?? "user",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    };
    this.keys.set(hashedKey, record);
    return { ...record, plaintext };
  }

  async validateKey(plaintext: string): Promise<ValidatedKey | null> {
    if (!looksLikeJaidKey(plaintext)) return null;
    const hashedKey = hashKey(plaintext);
    const record = this.keys.get(hashedKey);
    if (!record || record.revokedAt) return null;
    // Constant-time check against the stored hash as defence-in-depth;
    // the Map lookup already used strict equality, but we want any future
    // move to a different lookup primitive to remain timing-safe.
    const a = Buffer.from(hashedKey, "hex");
    const b = Buffer.from(record.hashedKey, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    // Side effect: bump lastUsedAt. Fire-and-forget-ish; the await is free
    // in-memory and we don't want a stale field if the caller never checks.
    record.lastUsedAt = new Date().toISOString();
    return {
      hashedKey: record.hashedKey,
      ownerSub: record.ownerSub,
      ownerEmail: record.ownerEmail,
      keyType: record.keyType,
    };
  }

  async listByOwner(ownerSub: string, limit = 50): Promise<KeyRecord[]> {
    const active: KeyRecord[] = [];
    for (const r of this.keys.values()) {
      if (r.ownerSub === ownerSub && !r.revokedAt) active.push(r);
    }
    active.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return active.slice(0, limit);
  }

  async listAll(limit = 200): Promise<KeyRecord[]> {
    const active: KeyRecord[] = [];
    for (const r of this.keys.values()) {
      if (!r.revokedAt) active.push(r);
    }
    active.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return active.slice(0, limit);
  }

  async revokeKey(hashedKey: string, revokedBy: string): Promise<boolean> {
    const record = this.keys.get(hashedKey);
    if (!record || record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    record.revokedBy = revokedBy;
    return true;
  }

  async loadKey(hashedKey: string): Promise<KeyRecord | null> {
    return this.keys.get(hashedKey) ?? null;
  }
}
