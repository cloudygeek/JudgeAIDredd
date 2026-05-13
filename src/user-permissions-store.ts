/**
 * User-permissions store.
 *
 * Per-(ownerSub, projectRoot) snapshot of the user's Claude Code
 * .permissions.{allow,deny,ask} lists, uploaded by the hook on every
 * UserPromptSubmit (see hooks/dredd-hook.sh::build_user_permissions_payload).
 *
 * Two implementations, same interface (mirrors `ApprovalStore`):
 *   - `InMemoryUserPermissionsStore` — process-local Map, local dev only.
 *   - `DynamoUserPermissionsStore`   — durable in `jaid-user-permissions`.
 *
 * Access pattern on /intent:
 *   1. Hook sends `user_permissions_hash` (always) + optional full payload.
 *   2. Server calls `get(ownerSub, projectRoot)`:
 *        - record present + hashes match → copy stored lists into session
 *          META, no further work.
 *        - record absent OR hashes differ → respond with
 *          `user_permissions_resync: true`. Next prompt re-uploads full.
 *      OR `upsert(...)` when the hook ships a full payload.
 *
 * NOT in scope for v1: GSI for "list every project I have policies for"
 * — single GetItem on the composite key covers the hot path. Add later
 * if Phase 5's dashboard listings need it.
 */

import { createHash } from "node:crypto";

/** Lists uploaded by the hook, before any server-side decoration. */
export interface UserPermissionsInput {
  ownerSub: string;
  projectRoot: string;
  /** sha256 of canonical {allow,deny,ask} per the hook's algorithm. */
  hash: string;
  allow: string[];
  deny: string[];
  ask: string[];
}

/** Persisted snapshot. updatedAt is server-stamped on every upsert. */
export interface UserPermissionsSnapshot extends UserPermissionsInput {
  updatedAt: string;
}

export interface UserPermissionsStore {
  /** Returns null when no row exists for this (user, project). */
  get(ownerSub: string, projectRoot: string): Promise<UserPermissionsSnapshot | null>;
  /** Idempotent — last writer wins on the canonical key (ownerSub, projectRoot). */
  upsert(input: UserPermissionsInput): Promise<UserPermissionsSnapshot>;
}

/**
 * Stable 16-char project key. Same hashing as DynamoApprovalStore so a
 * single project under (ownerSub) lines up across both tables when
 * cross-referenced from the dashboard.
 */
export function projectRootKey(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

// =============================================================================
// In-memory implementation
// =============================================================================

export class InMemoryUserPermissionsStore implements UserPermissionsStore {
  private readonly rows = new Map<string, UserPermissionsSnapshot>();

  private compositeKey(ownerSub: string, projectRoot: string): string {
    return `${ownerSub}#${projectRootKey(projectRoot)}`;
  }

  async get(ownerSub: string, projectRoot: string): Promise<UserPermissionsSnapshot | null> {
    return this.rows.get(this.compositeKey(ownerSub, projectRoot)) ?? null;
  }

  async upsert(input: UserPermissionsInput): Promise<UserPermissionsSnapshot> {
    const snapshot: UserPermissionsSnapshot = {
      ...input,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(this.compositeKey(input.ownerSub, input.projectRoot), snapshot);
    return snapshot;
  }
}
