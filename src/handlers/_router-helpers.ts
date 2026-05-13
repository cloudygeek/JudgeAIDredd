/**
 * Tiny router-only helpers — used by server-hook.ts's createServer
 * dispatcher but not by any individual handler. Kept alongside the
 * handlers so server-hook.ts can stay focused on routing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** CORS origin the dashboard container runs at. When unset, cross-
 *  origin requests are rejected — same-origin only, which is what
 *  the hook gets from Claude Code hooks. */
export const DASHBOARD_ORIGIN = process.env.DREDD_DASHBOARD_ORIGIN ?? "";

/**
 * Render process uptime as a compact human-readable string for the
 * landing page. Three thresholds: <1m → "Ns", <1h → "Nm Ns",
 * otherwise "Nh Nm". Days roll into hours so a 60h-old container
 * shows "60h" rather than "2d 12h" — the operator usually wants to
 * see "this is older than X" rather than the calendar split.
 */
export function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Apply CORS headers for endpoints the dashboard container calls.
 * Returns true and ends the response for OPTIONS preflight so the
 * caller can bail.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  if (!DASHBOARD_ORIGIN) return false;
  const origin = req.headers.origin;
  if (origin !== DASHBOARD_ORIGIN) return false;
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}
