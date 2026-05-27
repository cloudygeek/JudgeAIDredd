// src/byot/admin-target.ts
// Authorization helpers for the BYOT endpoints. Pure + small so the HTTP
// handler stays thin wiring and the policy is unit-tested without Clerk.
import type { ApiKeyStore } from "../api-key-store.js";

export interface ResolveByotTargetOpts {
  /** Caller's admin flag (from the verified Clerk principal). */
  isAdmin: boolean;
  /** Caller's own Clerk userId. */
  selfSub: string;
  /** ownerSub the caller asked to act on (query param or body). */
  requestedSub?: string | null;
}

export interface ResolvedByotTarget {
  /** Whose BYOT config the operation acts on. */
  targetOwner: string;
  /** True iff an admin is acting on a DIFFERENT user (⇒ stamp the actor).
   *  Non-admins, and admins targeting themselves, are never on-behalf. */
  actingOnBehalf: boolean;
}

/** Admins may target another user via `requestedSub`; everyone else is
 *  locked to `selfSub`. A blank/whitespace request falls back to self. */
export function resolveByotTarget(o: ResolveByotTargetOpts): ResolvedByotTarget {
  const requested = (o.requestedSub ?? "").trim();
  const targetOwner = o.isAdmin && requested ? requested : o.selfSub;
  return { targetOwner, actingOnBehalf: targetOwner !== o.selfSub };
}

/** True iff `ownerSub` has at least one API key — the "picker-only" guard
 *  so an admin can't seed a config for an arbitrary/typo'd sub. Uses the
 *  owner-indexed query (not the Scan path). */
export async function isKnownKeyOwner(
  apiKeys: Pick<ApiKeyStore, "listByOwner">,
  ownerSub: string,
): Promise<boolean> {
  const keys = await apiKeys.listByOwner(ownerSub, 1);
  return keys.length > 0;
}
