# Dashboard authentication — ALB OIDC vs. Clerk.com

Plan for adding user authentication to the dashboard container
(`https://judge-ai-dredd.aisandbox.dev.ckotech.internal/`). Two options
are evaluated, with Clerk as the primary plan and ALB OIDC as the fallback.

## Context

The recent server split (commits `...`) puts the dashboard in its own
Fargate service with a separate hostname. That split is deliberate — it
lets us put user auth on the dashboard **without touching the hook
container**, which will keep using per-user Bearer API keys (see
`src/api-key-store.ts`).

**What needs to be authenticated**:

- The dashboard UI (`GET /`)
- `GET /api/sessions`, `/api/session-log/:id`, `/api/policies`,
  `/api/logs*`, `/api/integration-bundle`, `/api/whoami`
- Future: `GET/POST/DELETE /api/api-keys/*` (user CRUD on their own
  hook keys — bound to the authed identity's `ownerSub`)

**What does NOT need this auth**:

- Hook endpoints on the hook container (`/intent`, `/evaluate`, `/track`,
  `/end`, `/pivot`, `/compact`). Those use `Authorization: Bearer
  jaid_live_…` API keys, validated against `jaid-api-keys`.
- Browser calls from the dashboard HTML to `DREDD_HOOK_URL/api/feed`,
  `/api/mode`, `/api/health`. Those are CORS-allowed reads — not
  individually authenticated per-request. We accept that a user who
  opens the dashboard can see the global feed and flip the trust mode;
  there is no per-tenant authorisation on those today.

---

## Option A (PRIMARY): Clerk

### Why Clerk

- Social login (Google, GitHub, Microsoft) and magic-link out of the
  box. No waiting on the platform team to wire an IdP.
- Hosted sign-in UI — zero UX work on our side.
- Node SDK (`@clerk/backend`) verifies JWTs with two lines of
  middleware.
- Free up to 10k MAU, which easily covers CKO-internal plus any early
  vibe-coder audience.
- Later: Clerk Organizations gives per-team scoping if we ever need
  multi-tenant keys.

### Architecture

```
┌──────────────────────┐           ┌────────────────────────┐
│ Dashboard container  │           │ Hook container         │
│ (OIDC-protected)     │           │ (API-key protected)    │
│                      │           │                        │
│ GET  /                           │ POST /intent           │
│   → serves HTML with             │ POST /evaluate         │
│     Clerk pub key +              │ POST /track etc.       │
│     DREDD_HOOK_URL               │                        │
│                      │           │ CORS-allowed from      │
│ Every /api/* checks  │           │ dashboard origin for:  │
│ Clerk session JWT    │           │   /api/feed            │
│ → req.authUser.sub   │           │   /api/mode            │
│   used as ownerSub   │           │   /api/health          │
│   for API keys       │           │                        │
└──────────────────────┘           └────────────────────────┘
         ▲                                  ▲
         │ Clerk JWT                        │ Bearer jaid_live_…
         │                                  │ (from hook script)
    ┌────┴──────┐                    ┌──────┴─────┐
    │ Operator  │                    │ Claude Code│
    │ browser   │                    │ hook       │
    └───────────┘                    └────────────┘
```

### Clerk is on the DASHBOARD only

The hook container stays **unchanged**. Hooks don't have a browser; they
can't do OIDC redirects. The API-key path we already built is the right
shape for machine-to-machine traffic.

The link between Clerk identity and hook keys: **when the dashboard
generates an API key, it uses the Clerk `userId` as the `ownerSub`**
stored in `jaid-api-keys`. Clerk users become the owners of hook keys.

### Implementation steps

Estimated effort: **2 hours**.

1. **Sign up / create a Clerk app**
   - Clerk dashboard → new application
   - Enable the social providers you want (Google + GitHub is the
     sensible minimum)
   - Grab the publishable key (`pk_test_…` / `pk_live_…`) and secret key
     (`sk_test_…` / `sk_live_…`)
   - Set the allowed origin to
     `https://judge-ai-dredd.aisandbox.dev.ckotech.internal`

2. **Install the SDK**
   ```
   npm i @clerk/backend
   ```
   No `@clerk/express` — we use raw `http.createServer`, not Express.
   The `@clerk/backend` package has a framework-neutral `verifyToken`.

3. **Wire middleware in `server-dashboard.ts`**

   Add two new env vars (passed via `fargate/docker-entrypoint-judge.sh`):
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`

   New helper (sketch):
   ```ts
   import { verifyToken } from "@clerk/backend";

   const CLERK_SECRET = process.env.CLERK_SECRET_KEY;

   async function requireClerkAuth(req, res) {
     const header = req.headers.authorization;
     const token = /^Bearer\s+(\S+)/i.exec(header ?? "")?.[1];
     if (!token) {
       json(res, 401, { error: "Missing Clerk session token" });
       return null;
     }
     try {
       const claims = await verifyToken(token, { secretKey: CLERK_SECRET });
       return { userId: claims.sub, email: claims.email, orgId: claims.org_id };
     } catch (err) {
       json(res, 401, { error: "Invalid Clerk session token" });
       return null;
     }
   }
   ```

   Apply at the top of every `/api/*` handler in `server-dashboard.ts`,
   except `/api/whoami` (which is the "am I authed?" probe).

4. **Inject the publishable key into the served HTML**

   Extend the existing injection in `server-dashboard.ts`:
   ```ts
   const inject = `<script>
     window.DREDD_HOOK_URL=${JSON.stringify(HOOK_URL)};
     window.CLERK_PUBLISHABLE_KEY=${JSON.stringify(process.env.CLERK_PUBLISHABLE_KEY ?? "")};
   </script>`;
   ```

5. **Update `dashboard.html`**

   Load Clerk's browser SDK from their CDN:
   ```html
   <script async data-clerk-publishable-key="..." src="https://<your-clerk-frontend-api>/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>
   ```
   (Clerk gives you the exact script tag in their dashboard.)

   At the top of the dashboard's main `<script>` block:
   ```js
   const Clerk = window.Clerk;
   await Clerk.load();
   if (!Clerk.user) {
     Clerk.openSignIn();
     return; // stop rendering until signed in
   }
   ```

   For every fetch to `/api/*` on the dashboard:
   ```js
   const token = await Clerk.session.getToken();
   const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
   ```

   Fetches to `HOOK_API/*` do **not** get the Clerk token — those are
   protected by their own CORS + API-key path.

6. **Tag feed identities with Clerk sub**

   Today's feed entries have `ownerSub: null` because no hook sends a
   key yet. When the API-keys tab is built (task #17 next step), the
   generate flow becomes:
   ```ts
   const { userId } = await requireClerkAuth(req, res);
   const gen = await apiKeys.generateKey({
     ownerSub: userId,
     ownerEmail: clerkClaims.email,
     description: body.description,
   });
   ```
   So every hook request made with that key will surface in the feed as
   `ownerSub: user_2abc…` — the Clerk user ID.

7. **Settings cog already exists**

   `/api/whoami` returns both ALB-OIDC headers (will be empty if we skip
   ALB auth) and now Clerk claims. The settings modal in `dashboard.html`
   needs one extra block that shows the Clerk identity.

### Cost

- Free tier: **10,000 monthly active users**. Anything CKO-internal or
  small-scale vibe-coder trial fits comfortably.
- Paid tier: $25/mo adds custom domain + other features.
- Pro tier: $99/mo adds SSO (SAML) — needed if we want Okta / Azure AD
  tie-in.

### Risks / watch-outs

- **Clerk is a SPOF for dashboard auth.** If Clerk is down, nobody can
  view the dashboard. The hook container is unaffected (hook keys are
  validated against DynamoDB, not Clerk).
- **JWT expiry.** Clerk session tokens are short (~60s), but the SDK
  auto-refreshes them. Make sure `Clerk.session.getToken()` is called
  per-request, not cached.
- **CORS.** If you ever change the dashboard's hostname, update Clerk's
  allowed origins list.
- **Social sign-ups.** With free-tier Clerk + Google login, anyone on
  the internet with a Google account can sign up. For an internal tool,
  you want to **restrict to a corporate Google Workspace domain** —
  configurable in Clerk's settings.

---

## Option B (FALLBACK): ALB OIDC

If the platform team can wire an OIDC authenticate action on the
dashboard ALB listener, we don't need Clerk at all. ALB OIDC:

- Uses CKO's corporate IdP directly (Okta / Azure AD / whatever).
- Is **free** — no per-user cost.
- Verifies JWTs at the edge — unauthenticated requests never reach our
  container.
- Forwards `x-amzn-oidc-data` (JWT), `x-amzn-oidc-identity` (sub),
  `x-amzn-oidc-accesstoken` to the container.
- Already scoped for in `src/server-dashboard.ts`'s `/api/whoami`
  endpoint — we just need to start **trusting** the headers (today we
  only display them).

### Implementation if we go ALB

1. **Platform ticket**: add `authenticate-oidc` action on the dashboard
   listener rule. Use CKO's corporate IdP. Forward all three OIDC
   headers.

2. **Server-side verification of the forwarded JWT**:
   - ALB signs the forwarded JWT with a **public key** published at
     `https://public-keys.auth.elb.<region>.amazonaws.com/<key-id>`.
   - The key-id is in the JWT header (`kid` claim).
   - Download the public key, cache it 24h, verify the signature before
     trusting the claims.
   - AWS provides a Node.js example; we'd adapt it into a middleware
     mirroring `authenticateHookRequest`.

3. **Same downstream behaviour** as Clerk: `sub` claim becomes the
   `ownerSub` for API keys.

### When to prefer ALB

- CKO already has an IdP and platform is willing to wire it: **use ALB**.
- Budget-sensitive / don't want another SaaS dependency: **use ALB**.
- Need SAML but don't want Clerk Pro: **use ALB**.

### When Clerk wins

- Platform team is slow / needs weeks of paperwork: **use Clerk**.
- You want social login for a broader (non-CKO) audience: **use Clerk**.
- You want a polished "sign in with Google" + magic-link UX: **use Clerk**.
- You want user self-service (account settings, MFA, sessions):
  **use Clerk**.

---

## Decision matrix

| Concern | Clerk | ALB OIDC |
|---|---|---|
| Time to live | 2 hours | Waiting on platform ticket |
| Free for ≤10k MAU | ✓ | ✓ (always free) |
| Social login UX | ✓ excellent | ✗ (depends on IdP) |
| Corporate SSO (Okta, Azure AD) | Pro tier ($99/mo) | ✓ (what ALB is for) |
| Verifies at edge | ✗ (in-app) | ✓ |
| Adds SaaS dependency | ✓ | ✗ |
| Works with non-CKO audience | ✓ | ✗ (IdP-gated) |
| User self-service UI | ✓ | ✗ |
| Audit logs | ✓ | (via CloudWatch) |

---

## Recommendation

**Try ALB OIDC first** (no cost, cleanest architecture), **fall back to
Clerk** if the platform team can't deliver in a reasonable timeframe or
if the audience needs to extend beyond CKO.

The server split makes switching between the two a ~20-line change in
`server-dashboard.ts`. We're not locked into either.

---

## Tasks (if Clerk is chosen)

1. Create Clerk app; obtain keys; restrict sign-ups to CKO domain.
2. Add `CLERK_SECRET_KEY` + `CLERK_PUBLISHABLE_KEY` env vars to
   `fargate/docker-entrypoint-judge.sh`.
3. `npm i @clerk/backend`.
4. Add `requireClerkAuth()` middleware to `server-dashboard.ts`.
5. Apply to every `/api/*` handler except `/api/whoami`.
6. Inject `CLERK_PUBLISHABLE_KEY` into served HTML.
7. Update `dashboard.html` to load Clerk SDK + gate rendering on
   `Clerk.user`.
8. Update every dashboard-side `fetch('/api/*')` to attach
   `Authorization: Bearer ${await Clerk.session.getToken()}`.
9. Extend `/api/whoami` to return Clerk claims.
10. Wire Clerk `userId` as `ownerSub` in the upcoming API-keys generate
    flow (task #17 step 2).

## Tasks (if ALB OIDC is chosen)

1. File platform ticket: "Add authenticate-oidc action to dashboard
   listener."
2. Add JWT signature verification using ALB's published public key.
3. Cache the key (24h TTL).
4. Update `/api/whoami` to extract claims from the verified JWT rather
   than the raw header.
5. Apply to every `/api/*` handler.
6. Wire `claims.sub` as `ownerSub` in the upcoming API-keys generate
   flow.
