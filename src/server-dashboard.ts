/**
 * Dashboard HTTP server.
 *
 * Separate container from the hook server. Serves the dashboard HTML,
 * session listings, session-log detail, policy dump, log downloads,
 * and the integration-bundle zip. Does NOT run the Bedrock/Ollama
 * preflight — the dashboard doesn't judge.
 *
 * Cross-container dependencies:
 *   - Reads the same `jaid-sessions` DynamoDB table as the hook container
 *     via `tracker` / `buildSessionLogShape` in server-core.
 *   - Pokes DREDD_HOOK_URL (set in env) for live feed + runtime mode
 *     toggle — the dashboard HTML calls those from the browser.
 *   - The integration bundle bakes DREDD_HOOK_URL into the downloaded
 *     hook script so users install a hook that points at the right server.
 *
 * Auth:
 *   - OIDC expected at the ALB (x-amzn-oidc-*). Today we only surface the
 *     identity via /api/whoami; enforcement is a follow-up task (#17).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  PORT,
  CONFIG,
  tracker,
  readBody,
  json,
  BodyTooLargeError,
  resolvePublicOrigin,
  buildSessionLogShape,
  flushLogs,
} from "./server-core.js";
import { exportPolicies } from "./tool-policy.js";
import { exportDomainPolicies } from "./domain-policy.js";

const HOOK_URL = process.env.DREDD_HOOK_URL ?? "";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      return json(res, 200, {
        status: "ok",
        version: pkg.version,
        role: "dashboard",
        hookUrl: HOOK_URL || null,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/whoami") {
      const oidcData = req.headers["x-amzn-oidc-data"] as string | undefined;
      const oidcIdentity = req.headers["x-amzn-oidc-identity"] as string | undefined;
      const hasAccessToken = !!req.headers["x-amzn-oidc-accesstoken"];

      let claims: Record<string, unknown> | null = null;
      let decodeError: string | null = null;
      if (oidcData) {
        try {
          const parts = oidcData.split(".");
          if (parts.length === 3) {
            const payload = Buffer.from(parts[1], "base64").toString("utf8");
            claims = JSON.parse(payload);
          } else {
            decodeError = `Expected 3 JWT segments, got ${parts.length}`;
          }
        } catch (err) {
          decodeError = err instanceof Error ? err.message : String(err);
        }
      }

      return json(res, 200, {
        role: "dashboard",
        authWired: !!oidcData,
        identity: oidcIdentity ?? null,
        hasAccessToken,
        claims,
        decodeError,
        seenHeaders: Object.keys(req.headers)
          .filter((h) => h.toLowerCase().startsWith("x-amzn-"))
          .sort(),
      });
    }

    // Dashboard HTML. Inject a small <script> block with DREDD_HOOK_URL
    // so the page can call cross-origin endpoints on the hook container
    // without hard-coding the URL in the shipped HTML.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      const htmlPath = new URL("./web/dashboard.html", import.meta.url);
      let html = readFileSync(htmlPath, "utf8");
      const inject = `<script>window.DREDD_HOOK_URL=${JSON.stringify(HOOK_URL)};</script>`;
      html = html.replace(/<head>/, `<head>${inject}`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      const ico = readFileSync(new URL("./web/favicon.ico", import.meta.url));
      res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" });
      res.end(ico);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const liveParam = url.searchParams.get("live");
      const liveOnly = liveParam !== "0";

      const all = await tracker.listSessions(50);
      const selected = liveOnly ? all.filter((s) => !s.endedAt) : all;

      const liveLogs: Record<string, unknown>[] = (await Promise.all(
        selected.map(async (s): Promise<Record<string, unknown> | null> => {
          const shape = await buildSessionLogShape(s.sessionId);
          if (!shape) return null;
          return { ...shape, startedAt: s.startedAt, endedAt: s.endedAt ?? null };
        }),
      )).filter((x): x is Record<string, unknown> => x !== null);
      const liveIds = new Set(liveLogs.map((s) => s.sessionId as string));

      const diskLogs: Record<string, unknown>[] = [];
      if (!liveOnly) {
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

      return json(res, 200, [...liveLogs, ...diskLogs].slice(0, 50));
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/session-log/")) {
      const id = url.pathname.split("/api/session-log/")[1];
      const live = await buildSessionLogShape(id);
      if (live) return json(res, 200, live);

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
      return json(res, 404, { error: "Session not found" });
    }

    if (req.method === "GET" && url.pathname === "/api/policies") {
      return json(res, 200, { ...exportPolicies(), domain: exportDomainPolicies() });
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      const dir = CONFIG.consoleLogDir;
      if (!existsSync(dir)) return json(res, 200, []);
      const files = readdirSync(dir)
        .filter((f) => f.startsWith("dredd-") && f.endsWith(".log"))
        .sort()
        .reverse();
      return json(res, 200, files);
    }

    if (req.method === "GET" && url.pathname === "/api/integration-bundle") {
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

    if (req.method === "GET" && url.pathname === "/api/logs/download") {
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

export async function main() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  console.log("█".repeat(50));
  console.log(`  JUDGE AI DREDD — DASHBOARD Server v${pkg.version}`);
  console.log("█".repeat(50));
  console.log(`  Hook URL:        ${HOOK_URL || "(unset — dashboard will try same-origin)"}`);
  console.log(`  Session logs:    ${CONFIG.logDir}`);
  console.log(`  Console logs:    ${CONFIG.consoleLogDir}`);

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
