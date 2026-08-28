/**
 * Hook-facing HTTP server.
 *
 * Hosts the hot path: POST /intent, /evaluate, /track, /end, /pivot,
 * /compact, /register. Plus status endpoints: /health, /api/health,
 * /api/data-status, /api/whoami. Plus the feed (cross-origin from the
 * dashboard) and the runtime mode toggle.
 *
 * What deliberately does NOT live here: dashboard HTML, session listings,
 * log file downloads, policies dump. Those live in `server-dashboard.ts`
 * and run in a separate container behind OIDC.
 *
 * CORS: /api/feed and /api/mode accept cross-origin requests from
 * DREDD_DASHBOARD_ORIGIN so the dashboard container's page can call them.
 * Every other endpoint is same-origin (the hook calls its own URL directly).
 */

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PORT,
  CONFIG,
  tracker,
  interceptor,
  registeredSessions,
  feed,
  readBody,
  json,
  BodyTooLargeError,
  rejectInvalidSessionId,
  flushLogs,
  AUTH_MODE,
  authenticateHookRequest,
  getClientIp,
  type TrustMode,
} from "./server-core.js";
import {
  CLERK_PUBLISHABLE_KEY,
  CLERK_ENABLED,
  isAdminEmail,
  isStatusViewer,
  tryVerifyClerk,
  STATUS_ALLOWLIST_ACTIVE,
} from "./clerk-auth.js";
import { getJudgeHealth } from "./judge-health.js";
import {
  INTENT_HISTORY_MODE,
  INTENT_CLASSIFIER_LLM_ENABLED,
  sessionModeOverride,
  sessionIntentModeOverride,
} from "./handlers/_shared.js";
import {
  DASHBOARD_ORIGIN,
  formatUptime,
  applyCors,
} from "./handlers/_router-helpers.js";
import { handleIntent } from "./handlers/intent.js";
import { handleRegister } from "./handlers/register.js";
import { handleEvaluate } from "./handlers/evaluate.js";
import { handleTrack } from "./handlers/track.js";
import { handleEnd } from "./handlers/end.js";
import { handleStop } from "./handlers/stop.js";
import { handleNotification, handleNotificationsGet } from "./handlers/notification.js";
import { handleInstructions } from "./handlers/instructions.js";
import { handleSessionGet } from "./handlers/session-get.js";
import { handlePivot, handleCompact } from "./handlers/pivot.js";
import { handleScreen } from "./handlers/screen.js";

// =========================================================================
// Router
// =========================================================================
// Health/status endpoints the ALB and operators poll constantly — kept
// out of the access log so CloudWatch isn't drowned in /health noise
// (the target-group health check hits /health every 15s).
const ACCESS_LOG_SKIP = new Set(["/health", "/api/health", "/", "/favicon.ico"]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Access log: record the ALB-observed client IP for every hot-path
  // request. The durable session↔IP join is stamped onto Dynamo META at
  // /intent (see handlers/intent.ts); this line gives the full per-request
  // trail (any IP change mid-session shows up here, not in META).
  if (!ACCESS_LOG_SKIP.has(url.pathname)) {
    console.log(`  [REQ] ${getClientIp(req) ?? "?"} ${req.method} ${url.pathname}`);
  }

  try {
    // GET / — tiny status landing page. The hook container has no
    // dashboard UI (that lives on the dashboard container). This page
    // is for operators / users who hit the URL directly to confirm
    // which container is on the other end and link them onward.
    if (req.method === "GET" && url.pathname === "/") {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      const dashboardOrigin = process.env.DREDD_DASHBOARD_ORIGIN ?? "";
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<script>window.CLERK_PUBLISHABLE_KEY=${JSON.stringify(CLERK_PUBLISHABLE_KEY)};</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Judge AI Dredd — Hook API</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 40px 24px; }
  .card { max-width: 720px; margin: 0 auto; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #f0f6fc; }
  h1 span { color: #58a6ff; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; font-size: 13px; margin: 20px 0; }
  .k { color: #8b949e; }
  .v { color: #c9d1d9; word-break: break-all; }
  .v.green { color: #3fb950; }
  .v.amber { color: #d29922; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb; }
  ul { list-style: none; padding: 0; margin: 16px 0; }
  li { padding: 4px 0; }
  li code { color: #d29922; }
  a { color: #58a6ff; }
  .muted { color: #8b949e; font-size: 12px; margin-top: 24px; line-height: 1.6; }
  .mode-select {
    background: #0d1117; color: #c9d1d9;
    border: 1px solid #30363d; border-radius: 6px;
    padding: 2px 8px; font: inherit; font-size: 13px; cursor: pointer;
  }
  .mode-select:hover { border-color: #8b949e; }
  .mode-select.mode-interactive { background: #d29922; color: #000; border-color: #d29922; }
  .mode-select.mode-autonomous { background: #f85149; color: #fff; border-color: #f85149; }
  .mode-select.mode-learn { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  #mode-status { color: #8b949e; font-size: 11px; margin-left: 8px; }
  #mode-status.err { color: #f85149; }
  #mode-status.ok { color: #3fb950; }
  /* Sign-in overlay — mirrors dashboard.html's gate. */
  .signin-overlay {
    position: fixed; inset: 0; background: #0d1117;
    display: flex; align-items: center; justify-content: center;
    z-index: 5000;
  }
  .signin-card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 32px 36px; max-width: 420px; text-align: center;
  }
  .signin-card h1 { font-size: 22px; margin-bottom: 4px; }
  .signin-card p { color: #8b949e; font-size: 14px; margin: 12px 0 24px; }
  .signin-btn {
    background: #1f6feb; color: #fff; border: none;
    border-radius: 6px; padding: 10px 18px; font-size: 14px;
    font-weight: 600; cursor: pointer;
  }
  .signin-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .signout-btn {
    background: transparent; color: #8b949e; border: 1px solid #30363d;
    border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer;
    font-family: inherit;
  }
  .signout-btn:hover { color: #c9d1d9; border-color: #8b949e; }
</style>
</head>
<body>
<div id="signin-overlay" class="signin-overlay">
  <div class="signin-card">
    <h1>Judge AI <span>Dredd</span></h1>
    <p id="signin-msg">Loading sign-in…</p>
    <button id="signin-btn" class="signin-btn" disabled onclick="dreddSignIn()">Sign in</button>
  </div>
</div>
<div id="main-page" class="card" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
    <div>
      <h1>Judge AI <span>Dredd</span> — Hook API</h1>
      <div class="sub">PreToolUse defence service for Claude Code hooks. <span class="pill">role: hook</span></div>
    </div>
    <div style="text-align:right;font-size:11px;color:#8b949e;white-space:nowrap">
      <div id="signed-in-as" style="margin-bottom:6px"></div>
      <button class="signout-btn" onclick="dreddSignOut()">Sign out</button>
    </div>
  </div>

  <div class="grid">
    <div class="k">Version</div><div class="v">${pkg.version}</div>
    <div class="k">Status</div><div class="v green">ok</div>
    <div class="k">Uptime</div><div class="v">${formatUptime(process.uptime())}</div>
    <div class="k">Mode</div><div class="v">
      <select id="mode-select" class="mode-select mode-${CONFIG.mode}" onchange="switchMode(this.value)" title="Flip the global trust mode for this hook container">
        <option value="interactive"${CONFIG.mode === "interactive" ? " selected" : ""}>interactive</option>
        <option value="autonomous"${CONFIG.mode === "autonomous" ? " selected" : ""}>autonomous</option>
        <option value="learn"${CONFIG.mode === "learn" ? " selected" : ""}>learn</option>
      </select>
      <span id="mode-status"></span>
    </div>
    <div class="k">Backend</div><div class="v">${CONFIG.judgeBackend}</div>
    <div class="k">Judge model</div><div class="v">${CONFIG.judgeModel}</div>
    <div class="k">Embedding</div><div class="v">${CONFIG.embeddingModel}</div>
    <div class="k">Prompt variant</div><div class="v">${CONFIG.hardened || "standard"}</div>
    <div class="k">Intent model</div><div class="v ${INTENT_HISTORY_MODE === "history-active" ? "green" : ""}">${INTENT_HISTORY_MODE}</div>
    <div class="k">LLM classifier</div><div class="v ${INTENT_CLASSIFIER_LLM_ENABLED ? "green" : "amber"}">${INTENT_CLASSIFIER_LLM_ENABLED ? "enabled" : "disabled"}</div>
    <div class="k">Active sessions</div><div class="v">${registeredSessions.size}</div>
    <div class="k">Auth mode</div><div class="v ${AUTH_MODE === "required" ? "green" : "amber"}">${AUTH_MODE}</div>
  </div>

  <div style="font-size: 12px; color: #8b949e; margin: 16px 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Hook endpoints</div>
  <ul>
    <li><code>POST /intent</code> — UserPromptSubmit</li>
    <li><code>POST /evaluate</code> — PreToolUse (judge pipeline)</li>
    <li><code>POST /track</code> — PostToolUse · <code>/instructions</code> — InstructionsLoaded</li>
    <li><code>POST /end</code> · <code>/pivot</code> · <code>/compact</code> · <code>/notification</code></li>
    <li><code>POST /screen</code> — PromptArmor detector (benchmark side-channel)</li>
    <li><code>GET /api/health</code> · <code>/api/whoami</code> · <code>/api/data-status</code></li>
    <li><code>GET /api/feed</code> · <code>POST /api/mode</code> · <code>POST /api/session-mode</code> · <code>GET /api/session-modes</code> <span style="color:#8b949e">(cross-origin from dashboard)</span></li>
  </ul>

  <div class="muted">
    The full operator dashboard lives on a separate container.
    ${dashboardOrigin ? `<br>Dashboard: <a href="${dashboardOrigin}">${dashboardOrigin}</a>` : `<br>Dashboard origin not configured (DREDD_DASHBOARD_ORIGIN unset).`}
    <br>To install the hook in your project, run <code>curl -O ${"https://" + (req.headers["x-forwarded-host"] || req.headers.host || "localhost")}/api/integration-bundle</code> from the dashboard.
  </div>
</div>
<script>
// ------------------------------------------------------------------
// Clerk authentication gate. Mirrors the flow in src/web/dashboard.html:
// load @clerk/clerk-js from the frontend API derived from the
// publishable key, then reveal #main-page only after Clerk reports a
// signed-in user. The hook API endpoints (/intent, /evaluate, /track,
// /api/mode, etc.) are deliberately unchanged — they keep their
// existing Bearer-API-key + CORS auth. This gate is presentation only.
// ------------------------------------------------------------------
const CLERK_PUBLISHABLE_KEY = window.CLERK_PUBLISHABLE_KEY || "";

async function loadClerkSdk() {
  if (!CLERK_PUBLISHABLE_KEY) {
    document.getElementById('signin-msg').textContent =
      'Hook UI auth not configured (CLERK_PUBLISHABLE_KEY missing on this container).';
    return null;
  }
  const partsB64 = CLERK_PUBLISHABLE_KEY.split('_')[2] || '';
  let frontendApi = '';
  try {
    frontendApi = atob(partsB64).replace(/\\$$/, '');
  } catch {
    document.getElementById('signin-msg').textContent =
      'Could not parse CLERK_PUBLISHABLE_KEY.';
    return null;
  }
  if (!frontendApi) {
    document.getElementById('signin-msg').textContent =
      'CLERK_PUBLISHABLE_KEY is malformed.';
    return null;
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://' + frontendApi + '/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.setAttribute('data-clerk-publishable-key', CLERK_PUBLISHABLE_KEY);
    s.onload = () => resolve(window.Clerk);
    s.onerror = () => reject(new Error('Failed to load Clerk SDK'));
    document.head.appendChild(s);
  });
}

async function bootstrapAuth() {
  try {
    const Clerk = await loadClerkSdk();
    if (!Clerk) return;
    await Clerk.load();
    window.__dreddClerk = Clerk;
    if (Clerk.user) {
      onSignedIn(Clerk);
    } else {
      document.getElementById('signin-msg').textContent =
        'Sign in to view the hook container status.';
      const btn = document.getElementById('signin-btn');
      btn.disabled = false;
      btn.textContent = 'Sign in';
      Clerk.addListener(({ user }) => {
        if (user) onSignedIn(Clerk);
      });
    }
  } catch (err) {
    document.getElementById('signin-msg').textContent =
      'Sign-in unavailable: ' + (err && err.message ? err.message : err);
  }
}

async function onSignedIn(Clerk) {
  const user = Clerk.user;
  const email =
    (user && user.primaryEmailAddress && user.primaryEmailAddress.emailAddress) ||
    (user && user.emailAddresses && user.emailAddresses[0] && user.emailAddresses[0].emailAddress) ||
    (user && user.id) ||
    'signed in';
  // Status allowlist: ask the server for a verdict on this identity so
  // the decision is made server-side (DREDD_STATUS_ALLOWED_EMAILS is
  // checked against the VERIFIED token, not the client's claims). Only
  // an explicit refusal blocks the reveal — statusViewer null means this
  // container can't verify Clerk tokens, and the gate stays
  // presentation-only exactly as before.
  try {
    const token = Clerk.session ? await Clerk.session.getToken() : null;
    if (token) {
      const r = await fetch('/api/whoami', { headers: { Authorization: 'Bearer ' + token } });
      const who = await r.json();
      if (who && who.clerk && who.clerk.statusViewer === false) {
        document.getElementById('signin-msg').textContent =
          email + ' is not on the status allowlist for this deployment. ' +
          'Ask the operator to add it to DREDD_STATUS_ALLOWED_EMAILS, ' +
          'or sign in with a listed account.';
        const btn = document.getElementById('signin-btn');
        btn.disabled = false;
        btn.textContent = 'Sign out';
        btn.onclick = dreddSignOut;
        return;
      }
    }
  } catch { /* verdict unavailable — behave as before the allowlist */ }
  document.getElementById('signed-in-as').textContent = email;
  document.getElementById('signin-overlay').style.display = 'none';
  document.getElementById('main-page').style.display = 'block';
}

function dreddSignIn() {
  const Clerk = window.__dreddClerk;
  if (Clerk) Clerk.openSignIn();
}

function dreddSignOut() {
  const Clerk = window.__dreddClerk;
  if (Clerk) Clerk.signOut().then(() => location.reload());
}

document.addEventListener('DOMContentLoaded', bootstrapAuth);

async function switchMode(next) {
  const select = document.getElementById('mode-select');
  const status = document.getElementById('mode-status');
  const prev = select.dataset.current || select.value;
  status.className = '';
  status.textContent = 'switching…';
  try {
    const resp = await fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    select.className = 'mode-select mode-' + data.mode;
    select.dataset.current = data.mode;
    status.className = 'ok';
    status.textContent = 'switched (' + data.previous + ' → ' + data.mode + ')';
    setTimeout(() => { status.textContent = ''; status.className = ''; }, 4000);
  } catch (err) {
    select.value = prev;
    status.className = 'err';
    status.textContent = 'failed: ' + err.message;
  }
}
document.getElementById('mode-select').dataset.current = ${JSON.stringify(CONFIG.mode)};
</script>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // /health (ALB target-group health check) — never CORSed, never auth'd.
    if (req.method === "GET" && url.pathname === "/health") {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      // Stays 200 even when the judge is down. A judge outage is GLOBAL, so
      // failing this check would pull every task out of the load balancer and
      // turn a degraded service into no service at all. Report it in the body
      // and let monitoring decide what to do about it.
      const jh = getJudgeHealth();
      return json(res, 200, {
        status: "ok",
        degraded: jh.status === "down" || jh.status === "degraded",
        version: pkg.version,
        role: "hook",
        config: CONFIG,
        activeSessions: registeredSessions.size,
        judge: jh,
      });
    }

    // /api/health — same payload, but the dashboard browser polls this
    // cross-origin to render the version + mode badge in its top bar.
    // Apply CORS (and respond to OPTIONS preflight) so it works.
    if (url.pathname === "/api/health") {
      if (applyCors(req, res)) return;
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      const jhApi = getJudgeHealth();
      return json(res, 200, {
        status: "ok",
        degraded: jhApi.status === "down" || jhApi.status === "degraded",
        version: pkg.version,
        role: "hook",
        config: CONFIG,
        judge: jhApi,
        activeSessions: registeredSessions.size,
        uptimeSeconds: Math.floor(process.uptime()),
        intentMode: INTENT_HISTORY_MODE,
        intentClassifierLlmEnabled: INTENT_CLASSIFIER_LLM_ENABLED,
      });
    }

    // /api/bedrock-metrics — in-process cost & cache-hit visibility.
    // Read-only, admin-only. The data is non-sensitive in isolation
    // (aggregate counters, no secrets, no per-session info) but it
    // does reveal call rates, token volumes, and cost — operational
    // observability that belongs behind the same admin gate as logs.
    //
    // Auth: Bearer API key, then admin-email check via Clerk-config
    // ADMIN_EMAILS. Cross-origin from the dashboard browser still
    // works because applyCors echoes Authorization. Non-admin keys
    // get a 403; missing/invalid keys land on 401 from
    // authenticateHookRequest.
    if (url.pathname === "/api/bedrock-metrics") {
      if (applyCors(req, res)) return;
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const identity = await authenticateHookRequest(req, res);
      if (!identity) return; // 401 already sent
      if (!isAdminEmail(identity.ownerEmail)) {
        return json(res, 403, { error: "Admin only" });
      }
      const { getBedrockMetrics } = await import("./bedrock-metrics.js");
      return json(res, 200, getBedrockMetrics());
    }

    // /api/hook-script — serves dredd-hook.sh with DREDD_URL baked in.
    // Bearer-gated (the hook server validates API keys; the dashboard's
    // /api/integration-bundle is Clerk-gated for browser users, so a CLI
    // install needs its own auth path). Used by the "let Claude install
    // Dredd for you" prompt: Claude curls this with the user's API key,
    // writes the body to ~/.claude/dredd/dredd-hook.sh, and chmod 755s
    // it. No zip / unzip step required.
    if (url.pathname === "/api/hook-script") {
      if (applyCors(req, res)) return;
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const identity = await authenticateHookRequest(req, res);
      if (!identity) return; // 401 already sent
      // Bake the caller-visible host into DREDD_URL AND inline the
      // managed-allow lib so the downloaded script is a single
      // self-contained file. Shared with the integration bundle via
      // hook-bake.ts (role-neutral, no dashboard-code import).
      const { buildBakedHook } = await import("./hook-bake.js");
      const dreddUrl = `https://${req.headers["x-forwarded-host"] || req.headers.host || "localhost"}`;
      const baked = buildBakedHook(dreddUrl);
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="dredd-hook.sh"',
        "Content-Length": Buffer.byteLength(baked, "utf8"),
      });
      res.end(baked);
      return;
    }

    // /api/auth-check — Bearer-key verification for the integration tab's
    // verify step. /api/health and /api/whoami both answer without auth,
    // which is exactly what makes them useless for confirming an API key
    // is wired up — a missing or bad key still returns 200. This endpoint
    // runs authenticateHookRequest so a missing/invalid key surfaces as
    // 401 and a valid key surfaces as 200 + the resolved owner identity.
    // Read-only; CORS so the dashboard can poll it from a browser too.
    if (url.pathname === "/api/auth-check") {
      if (applyCors(req, res)) return;
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const identity = await authenticateHookRequest(req, res);
      if (!identity) return; // 401 already sent by authenticateHookRequest
      return json(res, 200, {
        authenticated: identity.keyValid,
        ownerSub: identity.ownerSub,
        ownerEmail: identity.ownerEmail,
        keyType: identity.keyType,
      });
    }

    // /api/whoami — OIDC discovery. No auth; read-only.
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

      // Clerk verdict for the landing page's status-allowlist gate. The
      // page sends its Clerk session token here so the allow/refuse
      // decision is made SERVER-side (the reveal in the page JS is just
      // rendering this verdict). statusViewer is null when this container
      // can't verify Clerk tokens (no CLERK_SECRET_KEY /
      // CLERK_JWT_PUBLIC_KEY — the prod hook task ships neither) or no
      // token was sent — in that case the gate stays presentation-only,
      // exactly as before the allowlist existed.
      const clerkResult = await tryVerifyClerk(req);
      const clerkOk = clerkResult.ok;

      return json(res, 200, {
        role: "hook",
        authWired: !!oidcData,
        identity: oidcIdentity ?? null,
        hasAccessToken,
        claims,
        decodeError,
        clerk: {
          enabled: CLERK_ENABLED,
          authWired: clerkOk,
          email: clerkOk ? clerkResult.principal.email : null,
          isAdmin: clerkOk ? clerkResult.principal.isAdmin : false,
          statusViewer: clerkOk ? isStatusViewer(clerkResult.principal.email) : null,
          statusAllowlistActive: STATUS_ALLOWLIST_ACTIVE,
        },
        seenHeaders: Object.keys(req.headers)
          .filter((h) => h.toLowerCase().startsWith("x-amzn-"))
          .sort(),
      });
    }

    // /api/data-status — EFS mount probe. Used by the dashboard container
    // to show operators whether /data survives restart. Read-only.
    if (req.method === "GET" && url.pathname === "/api/data-status") {
      const sessionDir = CONFIG.logDir;
      const consoleDir = CONFIG.consoleLogDir;
      const dataDir =
        sessionDir.endsWith("/sessions") ? sessionDir.slice(0, -"/sessions".length) : sessionDir;

      let mounts: Array<{ source: string; target: string; fstype: string; options: string }> = [];
      try {
        mounts = readFileSync("/proc/mounts", "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [source, target, fstype, options] = line.split(/\s+/);
            return { source, target, fstype, options };
          });
      } catch {
        // Not Linux.
      }

      const mountFor = (path: string) => {
        const match = mounts
          .filter((m) => path === m.target || path.startsWith(m.target + "/"))
          .sort((a, b) => b.target.length - a.target.length)[0];
        return match ?? null;
      };

      const describeDir = (dir: string) => {
        if (!existsSync(dir)) {
          return { path: dir, exists: false };
        }
        let files: string[] = [];
        try { files = readdirSync(dir); } catch { files = []; }
        let bytes = 0;
        let newest: { name: string; mtime: string; size: number } | null = null;
        for (const name of files) {
          try {
            const st = statSync(join(dir, name));
            if (!st.isFile()) continue;
            bytes += st.size;
            if (!newest || st.mtimeMs > Date.parse(newest.mtime)) {
              newest = { name, mtime: new Date(st.mtimeMs).toISOString(), size: st.size };
            }
          } catch {}
        }
        return { path: dir, exists: true, fileCount: files.length, totalBytes: bytes, newest };
      };

      const dataMount = mountFor(dataDir);
      return json(res, 200, {
        dataDir,
        sessionDir,
        consoleDir,
        mount: dataMount
          ? {
              source: dataMount.source,
              target: dataMount.target,
              fstype: dataMount.fstype,
              options: dataMount.options,
              persistent:
                dataMount.fstype === "nfs" ||
                dataMount.fstype === "nfs4" ||
                dataMount.fstype === "efs" ||
                !["overlay", "overlay2", "tmpfs", "aufs"].includes(dataMount.fstype),
            }
          : { persistent: false, note: "not a mount point — ephemeral container layer" },
        sessions: describeDir(sessionDir),
        logs: describeDir(consoleDir),
      });
    }

    // /api/feed — cross-origin from the dashboard.
    if (url.pathname === "/api/feed") {
      if (applyCors(req, res)) return;
      if (req.method === "GET") return json(res, 200, feed);
    }

    // /api/mode — cross-origin from the dashboard. Flips trust mode for
    // the whole server in-process. Preflight handled above; POST below.
    //
    // Auth: admin only — this changes the defence posture for EVERY
    // session in the server. Accepts Clerk JWT (from dashboard browser)
    // or admin API key (from CLI). A previous version was CORS-only,
    // which let an anonymous internet caller flip prod to learn mode
    // (confirmed exploit, 2026-05-23 audit).
    if (url.pathname === "/api/mode") {
      if (applyCors(req, res)) return;
      if (req.method === "POST") {
        const { authenticateHookOrDashboard } = await import("./server-core.js");
        const identity = await authenticateHookOrDashboard(req, res);
        if (!identity) return;
        if (!identity.isAdmin) {
          return json(res, 403, { error: "Admin only" });
        }
        const body = JSON.parse(await readBody(req));
        const next = body.mode;
        if (next !== "interactive" && next !== "autonomous" && next !== "learn") {
          return json(res, 400, { error: "mode must be one of: interactive, autonomous, learn" });
        }
        const prev = CONFIG.mode;
        CONFIG.mode = next as TrustMode;
        console.log(`  [MODE] runtime switch: ${prev} → ${next} (by ${identity.ownerEmail ?? identity.ownerSub ?? "?"} via ${identity.authVia})`);

        // Mode flips are dev-only. The interactive intent stack and the
        // autonomous single-goal model have different invariants — when
        // the operator flips, the safest thing is to drop in-flight
        // intent context for every session this container knows about.
        // The next /intent on each session re-seeds correctly under the
        // new mode. We don't touch session_id sets / tool history.
        const sessions = await tracker.listSessions(500);
        for (const s of sessions) {
          await tracker.setActiveIntents(s.sessionId, []).catch(() => {});
        }
        if (sessions.length > 0) {
          console.log(`  [MODE] cleared intent stacks for ${sessions.length} session(s)`);
        }

        return json(res, 200, { mode: CONFIG.mode, previous: prev });
      }
    }

    // /api/session-mode — cross-origin from the dashboard. Per-session
    // mode override that beats both body.mode and the global CONFIG.mode.
    // Used to rescue a session whose intent stack has locked onto a stale
    // goal: flip it to learn, finish the work, then clear. Unlike
    // /api/mode this does NOT clear any intent stacks — the whole point
    // is to keep the same session running.
    // Auth: caller must own the session (or be admin). The previous
    // version was CORS-only, which let an anonymous caller flip ANY
    // session's mode given just its UUID.
    if (url.pathname === "/api/session-mode") {
      if (applyCors(req, res)) return;
      if (req.method === "POST") {
        const { authenticateHookOrDashboard } = await import("./server-core.js");
        const identity = await authenticateHookOrDashboard(req, res);
        if (!identity) return;
        const body = JSON.parse(await readBody(req));
        const sid: unknown = body.session_id;
        if (typeof sid !== "string") return json(res, 400, { error: "Missing session_id" });
        if (rejectInvalidSessionId(res, sid)) return;
        if (!identity.isAdmin) {
          const sessionOwner = await tracker.getSessionOwner(sid);
          if (!sessionOwner.ownerSub || sessionOwner.ownerSub !== identity.ownerSub) {
            return json(res, 403, { error: "Forbidden — session is not owned by caller" });
          }
        }
        const next = body.mode;
        if (next === null) {
          const prev = sessionModeOverride.get(sid) ?? null;
          sessionModeOverride.delete(sid);
          console.log(`  [${sid.substring(0, 8)}] [SESSION-MODE] cleared (was ${prev ?? "none"}) by ${identity.ownerEmail ?? identity.ownerSub}`);
          return json(res, 200, { session_id: sid, mode: null, previous: prev });
        }
        if (next !== "interactive" && next !== "autonomous" && next !== "learn") {
          return json(res, 400, { error: "mode must be interactive, autonomous, learn, or null" });
        }
        const prev = sessionModeOverride.get(sid) ?? null;
        sessionModeOverride.set(sid, next as TrustMode);
        console.log(`  [${sid.substring(0, 8)}] [SESSION-MODE] override ${prev ?? "none"} → ${next} by ${identity.ownerEmail ?? identity.ownerSub}`);
        return json(res, 200, { session_id: sid, mode: next, previous: prev });
      }
      if (req.method === "GET") {
        const { authenticateHookOrDashboard } = await import("./server-core.js");
        const identity = await authenticateHookOrDashboard(req, res);
        if (!identity) return;
        const session_id = url.searchParams.get("session_id") ?? "";
        if (!session_id || rejectInvalidSessionId(res, session_id)) return;
        if (!identity.isAdmin) {
          const sessionOwner = await tracker.getSessionOwner(session_id);
          if (!sessionOwner.ownerSub || sessionOwner.ownerSub !== identity.ownerSub) {
            return json(res, 403, { error: "Forbidden — session is not owned by caller" });
          }
        }
        return json(res, 200, {
          session_id,
          mode: sessionModeOverride.get(session_id) ?? null,
          global_mode: CONFIG.mode,
        });
      }
    }

    // /api/session-intent-mode — per-session override of the
    // INTENT_HISTORY_MODE flag. Same shape as /api/session-mode but
    // for the history-active rollout. POST {session_id, mode:
    // "legacy"|"history-active"|null} to set/clear; GET ?session_id
    // to read. Lets us A/B-test the new classifier on individual
    // sessions in a sandbox while production stays on legacy.
    // Auth: same model as /api/session-mode — owner-or-admin.
    if (url.pathname === "/api/session-intent-mode") {
      if (applyCors(req, res)) return;
      if (req.method === "POST") {
        const { authenticateHookOrDashboard } = await import("./server-core.js");
        const identity = await authenticateHookOrDashboard(req, res);
        if (!identity) return;
        const body = JSON.parse(await readBody(req));
        const sid: unknown = body.session_id;
        if (typeof sid !== "string") return json(res, 400, { error: "Missing session_id" });
        if (rejectInvalidSessionId(res, sid)) return;
        if (!identity.isAdmin) {
          const sessionOwner = await tracker.getSessionOwner(sid);
          if (!sessionOwner.ownerSub || sessionOwner.ownerSub !== identity.ownerSub) {
            return json(res, 403, { error: "Forbidden — session is not owned by caller" });
          }
        }
        const next = body.mode;
        if (next === null) {
          const prev = sessionIntentModeOverride.get(sid) ?? null;
          sessionIntentModeOverride.delete(sid);
          console.log(`  [${sid.substring(0, 8)}] [SESSION-INTENT-MODE] cleared (was ${prev ?? "none"}) by ${identity.ownerEmail ?? identity.ownerSub}`);
          return json(res, 200, { session_id: sid, intent_mode: null, previous: prev });
        }
        if (next !== "legacy" && next !== "history-active") {
          return json(res, 400, { error: "intent_mode must be legacy, history-active, or null" });
        }
        const prev = sessionIntentModeOverride.get(sid) ?? null;
        sessionIntentModeOverride.set(sid, next);
        console.log(`  [${sid.substring(0, 8)}] [SESSION-INTENT-MODE] override ${prev ?? "none"} → ${next} by ${identity.ownerEmail ?? identity.ownerSub}`);
        return json(res, 200, { session_id: sid, intent_mode: next, previous: prev });
      }
      if (req.method === "GET") {
        const { authenticateHookOrDashboard } = await import("./server-core.js");
        const identity = await authenticateHookOrDashboard(req, res);
        if (!identity) return;
        const session_id = url.searchParams.get("session_id") ?? "";
        if (!session_id || rejectInvalidSessionId(res, session_id)) return;
        if (!identity.isAdmin) {
          const sessionOwner = await tracker.getSessionOwner(session_id);
          if (!sessionOwner.ownerSub || sessionOwner.ownerSub !== identity.ownerSub) {
            return json(res, 403, { error: "Forbidden — session is not owned by caller" });
          }
        }
        return json(res, 200, {
          session_id,
          intent_mode: sessionIntentModeOverride.get(session_id) ?? null,
          global_intent_mode: INTENT_HISTORY_MODE,
        });
      }
    }

    // /api/session-modes — bulk read of per-session overrides. The
    // dashboard's sessions table calls this once per refresh to render
    // the per-row mode dropdown.
    //
    // Auth: filter to overrides for sessions the caller owns. Admins
    // see all (matches the rest of the dashboard's "admin sees all
    // users' rows" model in server-dashboard.ts). Non-admin sees only
    // their own — anonymous callers used to see every override.
    if (url.pathname === "/api/session-modes") {
      if (applyCors(req, res)) return;
      if (req.method === "GET") {
        const { authenticateHookOrDashboard } = await import("./server-core.js");
        const identity = await authenticateHookOrDashboard(req, res);
        if (!identity) return;
        const overrides: Record<string, TrustMode> = {};
        if (identity.isAdmin) {
          for (const [sid, m] of sessionModeOverride.entries()) overrides[sid] = m;
        } else {
          // Look up owner for each overridden session and keep only the
          // caller's. This is O(N overrides × 1 Dynamo Get) — fine for
          // the steady-state size of this map. If it grows we can index
          // by ownerSub in-process at write time.
          for (const [sid, m] of sessionModeOverride.entries()) {
            const owner = await tracker.getSessionOwner(sid).catch(() => ({ ownerSub: null }));
            if (owner.ownerSub === identity.ownerSub) overrides[sid] = m;
          }
        }
        return json(res, 200, { overrides, global_mode: CONFIG.mode });
      }
    }

    // /screen — PromptArmor head-to-head endpoint. Wraps
    // PromptArmorBaseline.screen() so the AgentDojo and MT-AgentRisk
    // Python runners can call it via requests.post without re-implementing
    // the detector pass in Python. Locked-down: model allow-list (only
    // the 5 backends from the test plan), content size cap, no
    // SessionTracker side-effects. This is a side-channel for benchmarks,
    // not part of the Dredd hot path.
    if (url.pathname === "/screen") {
      if (applyCors(req, res)) return;
      if (req.method === "POST") return await handleScreen(req, res);
    }

    // Debug/test helper — exposes a session's live context by id.
    // Bearer-API-key gated + owner check; the in-memory slice still
    // leaks recentTools, originalEmbedding, etc., so it must not be
    // anonymous. Dashboard uses /api/session-log/:id for the full shape.
    if (req.method === "GET" && url.pathname.startsWith("/session/")) {
      const id = url.pathname.split("/session/")[1];
      return await handleSessionGet(req, res, id);
    }

    // ------ Hook events -------------------------------------------------
    if (req.method === "POST" && url.pathname === "/intent")   return await handleIntent(req, res);
    if (req.method === "POST" && url.pathname === "/register") return await handleRegister(req, res);
    if (req.method === "POST" && url.pathname === "/evaluate") return await handleEvaluate(req, res);
    if (req.method === "POST" && url.pathname === "/track")    return await handleTrack(req, res);
    if (req.method === "POST" && url.pathname === "/end")      return await handleEnd(req, res);
    if (req.method === "POST" && url.pathname === "/stop")     return await handleStop(req, res);
    if (req.method === "POST" && url.pathname === "/pivot")    return await handlePivot(req, res);
    if (req.method === "POST" && url.pathname === "/compact")  return await handleCompact(req, res);
    if (req.method === "POST" && url.pathname === "/notification") return await handleNotification(req, res);
    if (req.method === "POST" && url.pathname === "/instructions") return await handleInstructions(req, res);

    if (req.method === "GET" && url.pathname.startsWith("/api/notifications/")) {
      const id = url.pathname.split("/api/notifications/")[1];
      return handleNotificationsGet(res, id);
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
// Startup
// =========================================================================
export async function main() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  console.log("█".repeat(50));
  console.log(`  JUDGE AI DREDD — HOOK Server v${pkg.version}`);
  console.log("█".repeat(50));

  if (process.env.DREDD_SKIP_PREFLIGHT === "1") {
    console.warn("  [PREFLIGHT] skipped (DREDD_SKIP_PREFLIGHT=1) — test mode");
  } else {
    await interceptor.preflight();
  }
  console.log(`  Mode:            ${CONFIG.mode}`);
  console.log(`  Embedding model: ${CONFIG.embeddingModel}`);
  console.log(`  Judge backend:   ${CONFIG.judgeBackend}`);
  console.log(`  Judge model:     ${CONFIG.judgeModel}`);
  console.log(`  Judge prompt:    ${CONFIG.hardened || "standard"}`);
  if (CONFIG.judgeEffort) console.log(`  Judge effort:    ${CONFIG.judgeEffort}`);
  console.log(`  Thresholds:      review=${CONFIG.reviewThreshold}, deny=${CONFIG.denyThreshold}`);
  console.log(`  Hijack lock:     ${CONFIG.hijackThreshold} strike${CONFIG.hijackThreshold === 1 ? "" : "s"} (autonomous mode only)`);
  console.log(`  Session logs:    ${CONFIG.logDir}`);
  console.log(`  Console logs:    ${CONFIG.consoleLogDir}`);
  console.log(`  Dashboard CORS:  ${DASHBOARD_ORIGIN || "(disabled — DREDD_DASHBOARD_ORIGIN unset)"}`);
  console.log(`  Intent model:    ${INTENT_HISTORY_MODE}` +
    (INTENT_HISTORY_MODE === "history-active"
      ? ` (LLM classifier ${INTENT_CLASSIFIER_LLM_ENABLED ? "ON" : "OFF"})`
      : ` (legacy single-stack — sub-task / replacement / revisit kinds disabled)`));

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  Listening on http://0.0.0.0:${PORT}`);
    console.log(`\n  Endpoints:`);
    console.log(`    POST /intent    — UserPromptSubmit (register intent)`);
    console.log(`    POST /evaluate  — PreToolUse (evaluate tool call)`);
    console.log(`    POST /track     — PostToolUse (record file/env state); is_error=PostToolUseFailure`);
    console.log(`    POST /instructions — InstructionsLoaded (CLAUDE.md / rules judge evidence)`);
    console.log(`    POST /end       — Stop (write log, cleanup)`);
    console.log(`    POST /pivot     — explicit direction change`);
    console.log(`    POST /compact   — context compaction notification`);
    console.log(`    POST /notification — Notification hook (friction signal)`);
    console.log(`    POST /screen    — PromptArmor detector (benchmark side-channel)`);
    console.log(`    GET  /api/notifications/:id — per-session friction counter`);
    console.log(`    POST /api/mode  — runtime trust-mode switch`);
    console.log(`    POST /api/session-mode — per-session mode override`);
    console.log(`    GET  /api/session-modes — bulk read of overrides`);
    console.log(`    GET  /health    — health check + version`);
    console.log(`    GET  /api/feed  — live event ring buffer (cross-origin)`);
    console.log("█".repeat(50));
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully");
    server.close(async () => {
      // Drain pending log lines to disk before exiting so the last
      // few seconds of activity (the SIGTERM, the close events) make
      // it into the daily file.
      await flushLogs();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  });
}
