/**
 * Dashboard HTTP server.
 *
 * Separate container from the hook server. Serves the dashboard HTML,
 * session listings, session-log detail, policy dump, log downloads,
 * the integration-bundle zip, and per-user API-key CRUD. Does NOT run
 * the Bedrock/Ollama preflight — the dashboard doesn't judge.
 *
 * Cross-container dependencies:
 *   - Reads the same `jaid-sessions` DynamoDB table as the hook container
 *     via `tracker` / `buildSessionLogShape` in server-core.
 *   - Reads `jaid-api-keys` for the API-keys tab + reads via `apiKeys`.
 *   - Pokes DREDD_HOOK_URL (set in env) for live feed + runtime mode
 *     toggle — the dashboard HTML calls those from the browser, attaching
 *     the Clerk session token so the hook can attribute the request.
 *
 * Auth (Clerk):
 *   - Every /api/* call (except /health, /api/health, /api/whoami) must
 *     present a valid Clerk session JWT in `Authorization: Bearer …`.
 *   - Admin emails (adrian.asher@checkout.com, adrianasher30@gmail.com)
 *     can list every user's sessions, every user's API keys, and toggle
 *     the global trust mode.
 *   - Non-admin users see only the sessions their API key initiated
 *     (filtered by SessionStore.ownerSub matching their Clerk userId)
 *     and only their own API keys. They cannot see admin-only routes.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  PORT,
  CONFIG,
  tracker,
  apiKeys,
  approvals,
  readBody,
  json,
  BodyTooLargeError,
  resolvePublicOrigin,
  buildSessionLogShape,
  flushLogs,
  byotService,
} from "./server-core.js";
import type { ApprovalRecord } from "./approval-store.js";
import type { SessionSummary } from "./session-store.js";
import { exportPolicies } from "./tool-policy.js";
import { exportDomainPolicies } from "./domain-policy.js";
import {
  requireClerkAuth,
  tryVerifyClerk,
  probeClerkConnectivity,
  CLERK_PUBLISHABLE_KEY,
} from "./clerk-auth.js";
import { resolveByotTarget, isKnownKeyOwner } from "./byot/admin-target.js";
import type { ByotActor } from "./byot/types.js";

const HOOK_URL = process.env.DREDD_HOOK_URL ?? "";

/** Map a SessionSummary into the lightweight shape the dashboard session
 *  list consumes — counts + last classification + badges, NO full
 *  per-session reconstruction. The full shape is fetched on click via
 *  /api/session-log/:id. Exported for unit testing. */
export function sessionListEntry(s: SessionSummary): Record<string, unknown> {
  return {
    sessionId: s.sessionId,
    originalTask: s.originalTask,
    timestamp: s.startedAt, // alias: the session-list row reads s.timestamp
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    summary: {
      toolCalls: s.toolCallCount ?? 0,
      denied: s.deniedCount ?? 0,
      filesWritten: s.fileWriteCount ?? 0,
      turns: s.currentTurn ?? 0,
    },
    turnMetrics: s.lastClassification ? [{ classification: s.lastClassification }] : [],
    clientIp: s.clientIp ?? null,
    userPermissions: s.userPermissions ?? null,
    ownerSub: s.ownerSub ?? null,
    ownerEmail: s.ownerEmail ?? null,
  };
}

// Short-TTL cache for GET /api/sessions. The dashboard UI polls this every
// 5s, and the handler fans out one full buildSessionLogShape per live
// session (50× Dynamo reconstructions of large sessions). Without a cache,
// each poll — and every open tab — re-runs that fan-out, which on a large
// jaid-sessions table (~18k items) saturates the single-threaded event loop
// and starves the ALB /health check (the 2026-05-26 dashboard outage).
// Caching the assembled response collapses all polls/tabs within the window
// into a single computation. Keyed by (scope, liveOnly) so admin/non-admin
// and live/all views don't share entries.
const SESSIONS_CACHE_TTL_MS = parseInt(process.env.DREDD_SESSIONS_CACHE_TTL_MS ?? "5000", 10);
const sessionsCache = new Map<string, { at: number; body: unknown }>();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    // ---------------------------------------------------------------
    // Unauthenticated endpoints. These are deliberately accessible
    // without a Clerk token: the ALB target-group probes /health, the
    // dashboard's pre-sign-in HTML calls /api/health to render its
    // status badge, and /api/whoami is the post-sign-in identity probe
    // (auth is done client-side by Clerk; this just echoes claims).
    // ---------------------------------------------------------------
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      return json(res, 200, {
        status: "ok",
        version: pkg.version,
        role: "dashboard",
        hookUrl: HOOK_URL || null,
        clerkConfigured: !!CLERK_PUBLISHABLE_KEY,
      });
    }

    // Egress probe — diagnoses whether the container can reach Clerk's
    // frontend API. Deliberately unauthenticated so an operator can hit
    // it before anyone has signed in. Returns the resolved host so the
    // network team can compare against the firewall allowlist.
    if (req.method === "GET" && url.pathname === "/api/clerk-probe") {
      const result = await probeClerkConnectivity();
      return json(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/api/whoami") {
      // Identity probe. Returns Clerk identity if the bearer is valid,
      // otherwise reports authWired=false plus the verifier's failure
      // reason so the dashboard can show a useful error rather than a
      // generic "401". Never 401s itself.
      const result = await tryVerifyClerk(req);
      const ok = result.ok;
      return json(res, 200, {
        role: "dashboard",
        authWired: ok,
        identity: ok ? result.principal.userId : null,
        email: ok ? result.principal.email : null,
        isAdmin: ok ? result.principal.isAdmin : false,
        clerkConfigured: !!CLERK_PUBLISHABLE_KEY,
        authFailureReason: ok ? null : result.reason,
        authFailureError: ok ? null : (result.error ?? null),
      });
    }

    // Dashboard HTML. Inject DREDD_HOOK_URL and the Clerk publishable key
    // so the page can call cross-origin endpoints on the hook container
    // and bootstrap @clerk/clerk-js without hard-coding either.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      const htmlPath = new URL("./web/dashboard.html", import.meta.url);
      let html = readFileSync(htmlPath, "utf8");
      const inject =
        `<script>` +
        `window.DREDD_HOOK_URL=${JSON.stringify(HOOK_URL)};` +
        `window.CLERK_PUBLISHABLE_KEY=${JSON.stringify(CLERK_PUBLISHABLE_KEY)};` +
        `</script>`;
      html = html.replace(/<head>/, `<head>${inject}`);
      // No-cache so a redeploy is picked up on the next page load. The
      // page contains injected env (DREDD_HOOK_URL, CLERK_PUBLISHABLE_KEY)
      // and changes on every release; without these headers a stale
      // cached copy would keep using the old config and old auth flow,
      // which is exactly the bug we hit on the v0.1.283→v0.1.286 cutover.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      const ico = readFileSync(new URL("./web/favicon.ico", import.meta.url));
      res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" });
      res.end(ico);
      return;
    }

    // ---------------------------------------------------------------
    // Authenticated endpoints. From here every handler verifies a
    // Clerk session JWT and either returns ClerkPrincipal or 401s.
    // ---------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      const liveParam = url.searchParams.get("live");
      const liveOnly = liveParam !== "0";

      // Serve from the short-TTL cache when warm — collapses the 5s poll
      // (and every open tab) into one fan-out per window. See cache decl.
      const cacheKey = `${principal.isAdmin ? "admin" : principal.userId}:${liveOnly ? "live" : "all"}`;
      const cachedSessions = sessionsCache.get(cacheKey);
      if (cachedSessions && Date.now() - cachedSessions.at < SESSIONS_CACHE_TTL_MS) {
        return json(res, 200, cachedSessions.body);
      }

      const all = await tracker.listSessions(50);
      const visible = principal.isAdmin
        ? all
        : all.filter((s) => s.ownerSub === principal.userId);
      const selected = liveOnly ? visible.filter((s) => !s.endedAt) : visible;

      const liveLogs: Record<string, unknown>[] = selected.map(sessionListEntry);
      const liveIds = new Set(liveLogs.map((s) => s.sessionId as string));

      // Disk fallback only meaningful in admin mode — non-admin users have
      // no way to assert ownership of a legacy file with no ownerSub.
      const diskLogs: Record<string, unknown>[] = [];
      if (!liveOnly && principal.isAdmin) {
        const logDir = CONFIG.logDir;
        if (existsSync(logDir)) {
          const files = readdirSync(logDir)
            .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
            .sort()
            .reverse()
            .slice(0, 50);
          for (const f of files) {
            try {
              const parsed = JSON.parse(readFileSync(join(logDir, f), "utf8"));
              if (!liveIds.has(parsed.sessionId)) {
                if (!parsed.endedAt) parsed.endedAt = parsed.timestamp ?? new Date().toISOString();
                diskLogs.push(parsed);
              }
            } catch {}
          }
        }
      }

      const body = [...liveLogs, ...diskLogs].slice(0, 50);
      sessionsCache.set(cacheKey, { at: Date.now(), body });
      return json(res, 200, body);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/session-log/")) {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      const id = url.pathname.split("/api/session-log/")[1];
      const live = await buildSessionLogShape(id);
      if (live) {
        if (!principal.isAdmin) {
          const owner = await tracker.getSessionOwner(id);
          if (owner.ownerSub !== principal.userId) {
            return json(res, 404, { error: "Session not found" });
          }
        }
        return json(res, 200, live);
      }

      // Disk fallback admin-only.
      if (principal.isAdmin) {
        const logDir = CONFIG.logDir;
        if (existsSync(logDir)) {
          const file = readdirSync(logDir)
            .filter((f) => f.includes(id.substring(0, 12)))
            .sort()
            .reverse()[0];
          if (file) {
            const data = JSON.parse(readFileSync(join(logDir, file), "utf8"));
            return json(res, 200, data);
          }
        }
      }
      return json(res, 404, { error: "Session not found" });
    }

    if (req.method === "GET" && url.pathname === "/api/policies") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      return json(res, 200, { ...exportPolicies(), domain: exportDomainPolicies() });
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      // Console logs are admin-only — they contain every user's activity.
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (!principal.isAdmin) return json(res, 403, { error: "Admin only" });
      const dir = CONFIG.consoleLogDir;
      if (!existsSync(dir)) return json(res, 200, []);
      const files = readdirSync(dir)
        .filter((f) => f.startsWith("dredd-") && f.endsWith(".log"))
        .sort()
        .reverse();
      return json(res, 200, files);
    }

    if (req.method === "GET" && url.pathname === "/api/integration-bundle") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      const { buildIntegrationBundle } = await import("./integration-bundle.js");
      const dreddUrl = HOOK_URL || resolvePublicOrigin(req);
      const zip = buildIntegrationBundle(dreddUrl);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="judge-dredd-integration.zip"',
        "Content-Length": zip.length,
      });
      res.end(zip);
      return;
    }

    // /api/install-prompt — the "let Claude install Dredd for you" prompt
    // as a standalone file, for users who want to pipe it straight into
    // claude < prompt.txt without unpacking the whole bundle. Same Clerk
    // gate as the bundle — anonymous downloads would let an attacker
    // grab the prompt + craft a phishing message that imitates Dredd.
    if (req.method === "GET" && url.pathname === "/api/install-prompt") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      const { renderInstallPrompt } = await import("./integration-bundle.js");
      const dreddUrl = HOOK_URL || resolvePublicOrigin(req);
      const body = Buffer.from(renderInstallPrompt(dreddUrl), "utf8");
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="claude-install-prompt.txt"',
        "Content-Length": body.length,
      });
      res.end(body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/logs/download") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (!principal.isAdmin) return json(res, 403, { error: "Admin only" });
      const { buildZipArchive } = await import("./integration-bundle.js");
      const kind = url.searchParams.get("kind") ?? "all";
      const dateFilter = url.searchParams.get("date");
      const entries: Array<{ name: string; data: Buffer; mode: number }> = [];

      if ((kind === "all" || kind === "sessions") && existsSync(CONFIG.logDir)) {
        for (const f of readdirSync(CONFIG.logDir)) {
          if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
          const m = f.match(/(\d{4}-\d{2}-\d{2})/);
          const day = m ? m[1] : "undated";
          if (dateFilter && day !== dateFilter) continue;
          try {
            const data = readFileSync(join(CONFIG.logDir, f));
            entries.push({ name: `${day}/sessions/${f}`, data, mode: 0o644 });
          } catch {}
        }
      }

      if ((kind === "all" || kind === "console") && existsSync(CONFIG.consoleLogDir)) {
        for (const f of readdirSync(CONFIG.consoleLogDir)) {
          if (!f.startsWith("dredd-") || !f.endsWith(".log")) continue;
          const m = f.match(/dredd-(\d{4}-\d{2}-\d{2})\.log$/);
          const day = m ? m[1] : "undated";
          if (dateFilter && day !== dateFilter) continue;
          try {
            const data = readFileSync(join(CONFIG.consoleLogDir, f));
            entries.push({ name: `${day}/console/${f}`, data, mode: 0o644 });
          } catch {}
        }
      }

      if (entries.length === 0) {
        return json(res, 404, { error: "No logs matched" });
      }

      const zip = buildZipArchive(entries);
      const stamp = new Date().toISOString().slice(0, 10);
      const suffix = dateFilter ? dateFilter : stamp;
      const kindTag = kind === "all" ? "logs" : kind;
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="dredd-${kindTag}-${suffix}.zip"`,
        "Content-Length": zip.length,
      });
      res.end(zip);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/logs/")) {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (!principal.isAdmin) return json(res, 403, { error: "Admin only" });
      const filename = url.pathname.split("/api/logs/")[1];
      if (!filename || filename.includes("..") || filename.includes("/")) {
        return json(res, 400, { error: "Invalid filename" });
      }
      const filepath = join(CONFIG.consoleLogDir, filename);
      if (!existsSync(filepath)) return json(res, 404, { error: "Log not found" });
      const tail = parseInt(url.searchParams.get("tail") ?? "0", 10);
      const content = readFileSync(filepath, "utf8");
      if (tail > 0) {
        const lines = content.split("\n");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(lines.slice(-tail).join("\n"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(content);
      return;
    }

    // ---------------------------------------------------------------
    // API keys CRUD. The Clerk userId is the `ownerSub` we mint into
    // the API key record, which is also what the hook server stamps
    // on each session via setSessionOwner. That's the chain that
    // ties hook traffic back to a Clerk identity.
    // ---------------------------------------------------------------
    if (url.pathname === "/api/keys") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (req.method === "GET") {
        // TODO: replace the Scan with a Query against a dedicated GSI
        // (e.g. gsi2pk = "KEY") so the admin view scales as the table
        // grows. Scan cost is linear in table size and we'll feel it
        // once api-keys gets past a few thousand rows.
        // Admin view tries Scan; if the task role lacks dynamodb:Scan
        // (deliberately, in least-privilege deployments) we fall back
        // to listByOwner — admins still see their own keys, just not
        // every user's. Logged once so the operator knows it's
        // happening.
        let all;
        if (principal.isAdmin) {
          try {
            all = await apiKeys.listAll(200);
          } catch (err) {
            const code =
              (err as any)?.name === "AccessDeniedException"
                ? "AccessDeniedException"
                : null;
            if (code === "AccessDeniedException") {
              console.warn(
                "[admin-keys] listAll denied (dynamodb:Scan missing) — " +
                  "falling back to admin's own keys",
              );
              all = await apiKeys.listByOwner(principal.userId);
            } else {
              throw err;
            }
          }
        } else {
          all = await apiKeys.listByOwner(principal.userId);
        }
        return json(res, 200, all.map(redactKey));
      }
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const description = String(body.description ?? "").slice(0, 256);
        const generated = await apiKeys.generateKey({
          ownerSub: principal.userId,
          ownerEmail: principal.email || null,
          description,
          keyType: "user",
        });
        // Plaintext returned ONCE — frontend must surface this to the
        // user immediately and never store it.
        return json(res, 200, {
          plaintext: generated.plaintext,
          record: redactKey(generated),
        });
      }
      return json(res, 405, { error: "Method not allowed" });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/keys/")) {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      const hashedKey = url.pathname.split("/api/keys/")[1];
      if (!hashedKey || !/^[a-f0-9]{64}$/.test(hashedKey)) {
        return json(res, 400, { error: "Invalid key hash" });
      }
      // Non-admin can only revoke their own keys.
      if (!principal.isAdmin) {
        const record = await apiKeys.loadKey(hashedKey);
        if (!record || record.ownerSub !== principal.userId) {
          return json(res, 404, { error: "Key not found" });
        }
      }
      const ok = await apiKeys.revokeKey(hashedKey, principal.userId);
      return json(res, 200, { revoked: ok });
    }

    // ---------------------------------------------------------------
    // BYOT — per-user Bedrock token. GET status (never the token),
    // POST validate-then-store, DELETE remove. ownerSub = Clerk userId.
    // ---------------------------------------------------------------
    if (url.pathname === "/api/byot") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;

      // Build the on-behalf actor for write/delete when an admin targets
      // someone else. requireClerkAuth already verified isAdmin.
      const onBehalfActor = (target: { actingOnBehalf: boolean }): ByotActor | undefined =>
        target.actingOnBehalf
          ? { adminSub: principal.userId, adminEmail: principal.email || null }
          : undefined;

      if (req.method === "GET") {
        const target = resolveByotTarget({
          isAdmin: principal.isAdmin,
          selfSub: principal.userId,
          requestedSub: url.searchParams.get("ownerSub"),
        });
        if (target.actingOnBehalf && !(await isKnownKeyOwner(apiKeys, target.targetOwner))) {
          return json(res, 404, { error: "Unknown user" });
        }
        return json(res, 200, await byotService.getStatus(target.targetOwner));
      }

      if (req.method === "POST") {
        // Parse in an inner try so a malformed body NEVER reaches the
        // outer catch's console.error — Node's JSON.parse messages embed
        // a fragment of the raw body, which here could contain a pasted
        // token. Return 400 without logging the body.
        let body: any;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: "Invalid JSON body" });
        }
        const token = String(body.token ?? "").trim();
        const region = String(body.region ?? "").trim();
        if (!token) return json(res, 400, { error: "token is required" });
        if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) {
          return json(res, 400, { error: "valid AWS region is required (e.g. eu-west-2)" });
        }
        const target = resolveByotTarget({
          isAdmin: principal.isAdmin,
          selfSub: principal.userId,
          requestedSub: body.ownerSub,
        });
        if (target.actingOnBehalf && !(await isKnownKeyOwner(apiKeys, target.targetOwner))) {
          return json(res, 404, { error: "Unknown user" });
        }
        let result;
        try {
          result = await byotService.validateAndStore(
            target.targetOwner, token, region, onBehalfActor(target),
          );
        } catch (err) {
          // An unexpected error during the probe (not a probe failure) —
          // never echo the token back.
          return json(res, 502, { error: `validation error: ${(err as Error)?.name ?? "unknown"}` });
        }
        if (!result.stored) {
          return json(res, 400, {
            error: "Token validation failed — the region cannot serve all required models.",
            failures: result.probe.failures, // { model, api, error }[]
          });
        }
        return json(res, 200, await byotService.getStatus(target.targetOwner));
      }

      if (req.method === "DELETE") {
        // Self-serve DELETE sends no body; the admin panel sends { ownerSub }.
        // Read the body OUTSIDE the lenient catch so an oversized body still
        // surfaces as BodyTooLargeError → 413 via the outer handler. Only the
        // JSON.parse is lenient: a missing/blank/garbage body means "self".
        const raw = await readBody(req);
        let delBody: any = {};
        if (raw.trim()) {
          try {
            delBody = JSON.parse(raw);
          } catch {
            /* lenient: treat as self */
          }
        }
        const target = resolveByotTarget({
          isAdmin: principal.isAdmin,
          selfSub: principal.userId,
          requestedSub: delBody.ownerSub,
        });
        if (target.actingOnBehalf && !(await isKnownKeyOwner(apiKeys, target.targetOwner))) {
          return json(res, 404, { error: "Unknown user" });
        }
        await byotService.remove(target.targetOwner, onBehalfActor(target));
        return json(res, 200, { configured: false });
      }

      return json(res, 405, { error: "Method not allowed" });
    }

    // ---------------------------------------------------------------
    // Approvals — interactive-mode learning records. Same Clerk-scoping
    // as /api/keys: a non-admin sees only approvals their ownerSub
    // matches; admins see everyone's.
    // ---------------------------------------------------------------
    if (url.pathname === "/api/approvals") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (req.method === "GET") {
        let records: ApprovalRecord[];
        if (principal.isAdmin) {
          try {
            records = await approvals.listAll(500);
          } catch (err) {
            if ((err as any)?.name === "AccessDeniedException") {
              console.warn(
                "[admin-approvals] listAll denied (dynamodb:Scan missing) — " +
                  "falling back to admin's own approvals",
              );
              records = await approvals.listByOwner(principal.userId, 500);
            } else {
              throw err;
            }
          }
        } else {
          records = await approvals.listByOwner(principal.userId, 500);
        }
        return json(res, 200, records.map(redactApproval));
      }
      return json(res, 405, { error: "Method not allowed" });
    }

    // Revoke takes the composite key in the body — fingerprintHash
    // alone isn't enough because approvals are scoped (ownerSub +
    // projectRoot). Non-admins can only revoke approvals they own;
    // attempts to revoke someone else's silently return 404 so the
    // existence of another user's records doesn't leak through.
    if (req.method === "POST" && url.pathname === "/api/approvals/revoke") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      const body = JSON.parse(await readBody(req));
      const fingerprintHash = String(body.fingerprintHash ?? "");
      const projectRoot = String(body.projectRoot ?? "");
      const targetOwner = principal.isAdmin
        ? String(body.ownerSub ?? principal.userId)
        : principal.userId;
      if (!fingerprintHash || !/^[a-f0-9]{64}$/.test(fingerprintHash)) {
        return json(res, 400, { error: "Invalid fingerprintHash" });
      }
      if (!projectRoot) {
        return json(res, 400, { error: "Missing projectRoot" });
      }
      const ok = await approvals.revoke(
        { ownerSub: targetOwner, projectRoot },
        fingerprintHash,
        principal.userId,
      );
      return json(res, 200, { revoked: ok });
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      console.warn(`[413] ${req.method} ${url.pathname}: body exceeded ${err.bodyLimit} bytes`);
      return json(res, 413, { error: "Request body too large" });
    }
    if (err instanceof SyntaxError) {
      console.warn(`[400] ${req.method} ${url.pathname}: invalid JSON: ${err.message}`);
      return json(res, 400, { error: "Invalid JSON body" });
    }
    console.error(`[ERROR] ${req.method} ${url.pathname}:`, err);
    json(res, 500, { error: "Internal server error" });
  }
});

server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 5_000;

// =========================================================================
// Helpers
// =========================================================================

/** Strip nothing today — KeyRecord is already plaintext-free — but routed
 *  through one place so a future schema addition (e.g. raw scopes) can be
 *  redacted in one edit rather than chasing call sites. */
function redactKey(record: any) {
  return {
    hashedKey: record.hashedKey,
    keyPreview: record.keyPreview,
    ownerSub: record.ownerSub,
    ownerEmail: record.ownerEmail,
    description: record.description,
    keyType: record.keyType,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
    revokedBy: record.revokedBy,
  };
}

/** Drops the 1024-dim goalEmbedding (only needed server-side for the
 *  intent-drift check). Everything else is already safe to display —
 *  raw secrets never reach this layer because the curl fingerprinter
 *  hashes Authorization headers at recording time. */
function redactApproval(record: ApprovalRecord) {
  return {
    fingerprintHash: record.fingerprintHash,
    summary: record.summary,
    // Structured shape so the dashboard can render Target + Credential
    // as first-class columns. Safe to expose: contains only host +
    // credential SOURCES (file path / cookie jar / basic user / value
    // hash) — never raw secret bytes (same safety as `summary`).
    fingerprintJson: record.fingerprintJson,
    tool: record.tool,
    ownerSub: record.ownerSub,
    ownerEmail: record.ownerEmail,
    projectRoot: record.projectRoot,
    grantedAt: record.grantedAt,
    lastUsedAt: record.lastUsedAt,
    useCount: record.useCount,
    expiresAt: record.expiresAt,
    intentSnapshot: record.intentSnapshot,
    revokedAt: record.revokedAt,
    revokedBy: record.revokedBy,
  };
}

export async function main() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  console.log("█".repeat(50));
  console.log(`  JUDGE AI DREDD — DASHBOARD Server v${pkg.version}`);
  console.log("█".repeat(50));
  console.log(`  Hook URL:        ${HOOK_URL || "(unset — dashboard will try same-origin)"}`);
  console.log(`  Session logs:    ${CONFIG.logDir}`);
  console.log(`  Console logs:    ${CONFIG.consoleLogDir}`);
  if (CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY) {
    const offline = !!process.env.CLERK_JWT_PUBLIC_KEY;
    console.log(
      `  Clerk auth:      configured (${offline ? "offline JWKS — no egress" : "network JWKS via api.clerk.com"})`,
    );
  } else {
    console.log("  Clerk auth:      NOT CONFIGURED — /api/* will 503");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  Listening on http://0.0.0.0:${PORT}`);
    console.log(`\n  Dashboard:  http://localhost:${PORT}/`);
    console.log("█".repeat(50));
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully");
    server.close(async () => {
      await flushLogs();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  });
}
