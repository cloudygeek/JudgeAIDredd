/**
 * Clerk authentication for the dashboard container.
 *
 * Verifies Clerk session JWTs in the `Authorization: Bearer <token>` header
 * via `@clerk/backend`'s framework-neutral `verifyToken`. Used by every
 * `/api/*` route handler in `server-dashboard.ts` (except `/health` and
 * `/api/health`, which the platform's ALB and the dashboard's own browser
 * hits unauthenticated for status display).
 *
 * Two roles:
 *  - admin    — emails listed in ADMIN_EMAILS. Can change trust mode, see
 *               every user's API keys, sessions, and console logs.
 *  - user     — any other authenticated identity. Can only see their own
 *               sessions (via SessionStore.ownerSub), only their own API
 *               keys, and cannot toggle trust mode.
 *
 * The admin allow-list is hard-coded on purpose. There is no public
 * "promote to admin" endpoint and no env-var override — adding an admin
 * means a code change and a redeploy. That's the right shape for a
 * privilege you can't otherwise audit.
 *
 * Auth wiring:
 *   - publishable key (browser): CLERK_PUBLISHABLE_KEY OR
 *     NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (whichever is set)
 *   - secret key (this module):  CLERK_SECRET_KEY
 *
 * If CLERK_SECRET_KEY is unset on a non-local deploy, every /api/* call
 * returns 503 "auth not configured" — fail-closed rather than expose
 * dashboard data.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import { verifyToken } from "@clerk/backend";
import { json } from "./server-core.js";

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "";
export const CLERK_PUBLISHABLE_KEY =
  process.env.CLERK_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
  "";

/** Hard-coded admin allow-list. Changing this requires a code commit. */
const ADMIN_EMAILS = new Set<string>([
  "adrian.asher@checkout.com",
  "adrianasher30@gmail.com",
]);

export interface ClerkPrincipal {
  /** Clerk userId (sub claim) — stable across sessions; used as ownerSub
   *  when minting API keys. */
  userId: string;
  /** Primary verified email. Empty if Clerk didn't surface one. */
  email: string;
  /** Set true iff `email` is in ADMIN_EMAILS. */
  isAdmin: boolean;
  /** Raw verified claims. For audit / future scope checks. */
  claims: Record<string, unknown>;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.toLowerCase());
}

function extractBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

function extractEmail(claims: Record<string, unknown>): string {
  // Clerk session JWTs contain a "primary_email_address_id" + a custom
  // template can include "email". We accept either; preferring "email"
  // because that's what we ask Clerk to put in the template.
  const direct = claims["email"];
  if (typeof direct === "string") return direct.toLowerCase();
  const eml = claims["primary_email"];
  if (typeof eml === "string") return eml.toLowerCase();
  // Fall back to userId so admin checks always fail gracefully when the
  // template is misconfigured (no admin promotion ever via a missing claim).
  return "";
}

/**
 * Verify the Clerk token on `req` without writing to `res`. Used by
 * /api/whoami where we want to surface "no auth yet" rather than 401.
 * Returns the principal on success, or a structured failure reason on
 * failure — the dashboard surfaces the reason in the sign-in overlay
 * so a misconfigured Clerk origin doesn't look like a generic "401".
 */
export type ClerkVerifyResult =
  | { ok: true; principal: ClerkPrincipal }
  | { ok: false; reason: "no-secret" | "no-token" | "no-sub" | "verify-failed"; error?: string };

export async function tryVerifyClerk(req: IncomingMessage): Promise<ClerkVerifyResult> {
  if (!CLERK_SECRET_KEY) return { ok: false, reason: "no-secret" };
  const token = extractBearer(req);
  if (!token) return { ok: false, reason: "no-token" };
  try {
    const claims = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
    const userId = (claims as any).sub;
    if (typeof userId !== "string" || !userId) {
      return { ok: false, reason: "no-sub" };
    }
    const email = extractEmail(claims as Record<string, unknown>);
    return {
      ok: true,
      principal: {
        userId,
        email,
        isAdmin: isAdminEmail(email),
        claims: claims as Record<string, unknown>,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Log so the operator can grep the daily log for verification
    // failures (mismatched origin, bad signature, expired token...).
    console.warn(`[clerk] verifyToken failed: ${error}`);
    return { ok: false, reason: "verify-failed", error };
  }
}

/**
 * Verify the Clerk session token on `req`. On success, returns a
 * ClerkPrincipal. On failure, writes a 401/503 response and returns null
 * — caller must `return` immediately.
 */
export async function requireClerkAuth(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<ClerkPrincipal | null> {
  if (!CLERK_SECRET_KEY) {
    json(res, 503, {
      error: "Dashboard auth not configured",
      detail: "CLERK_SECRET_KEY is unset on this container. Set it to enable sign-in.",
    });
    return null;
  }
  const token = extractBearer(req);
  if (!token) {
    json(res, 401, {
      error: "Missing Clerk session token",
      detail: "Send Authorization: Bearer <Clerk session JWT>. Sign in via the dashboard.",
    });
    return null;
  }
  try {
    const claims = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
    const userId = (claims as any).sub;
    if (typeof userId !== "string" || !userId) {
      json(res, 401, { error: "Clerk token missing sub claim" });
      return null;
    }
    const email = extractEmail(claims as Record<string, unknown>);
    return {
      userId,
      email,
      isAdmin: isAdminEmail(email),
      claims: claims as Record<string, unknown>,
    };
  } catch (err) {
    json(res, 401, {
      error: "Invalid Clerk session token",
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
