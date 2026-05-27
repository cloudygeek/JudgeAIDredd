# Admin sets BYOT token on behalf of a user

**Date:** 2026-05-27
**Status:** Design approved, pending spec review
**Author:** brainstormed with Adrian

## Problem

BYOT today is strictly self-serve: `/api/byot` (GET/POST/DELETE in
`server-dashboard.ts`) keys every operation on `principal.userId`, so a
signed-in user can only configure *their own* Bedrock token. There is no
way for an admin to provision a token on behalf of another user — needed
for onboarding (set up a teammate's billing token for them) and support
(fix or clear a broken config without round-tripping through the user).

We want an **admin** to view, set/replace, and clear the BYOT token for a
**selected user**, with an audit trail of who did it, disclosed to both
the admin and the affected user.

## Decisions

| Question | Decision |
|---|---|
| Endpoint shape | **Parameterize the existing `/api/byot`** (don't add a separate admin endpoint). Resolve `targetOwner = principal.isAdmin ? (provided ?? principal.userId) : principal.userId` — mirrors the `/api/approvals/revoke` precedent and reuses the existing token-safe POST parser. |
| User selection | **Picker from known users only.** Dropdown built from the existing admin `/api/keys` listing (already carries `ownerSub` + `ownerEmail`), deduped by `ownerSub`. No raw-ownerSub free-text entry. |
| Unknown target | If an admin supplies an `ownerSub` that is **not a known API-key owner**, the call **404s** — admins cannot seed configs for arbitrary/typo'd subs. |
| Admin scope | **View + set + clear** for the selected user. |
| Audit & disclosure | Stamp acting admin (`setByAdminSub` / `setByAdminEmail` / `setByAdminAt`) on the record. Surface "managed by `<admin>`" on **both** the admin view and the target user's own BYOT tab. |
| User reclaim | When the **user** writes their own token, the admin stamp is **cleared** (set null) — a user replacing an admin-set token reclaims ownership. |
| Non-admin guard | A non-admin supplying `ownerSub` has it **silently ignored** (locked to self), same hardening as `/api/approvals/revoke`. |
| New endpoints | **None.** Picker reuses `/api/keys`; status/set/clear reuse `/api/byot` parameterized. |
| Cross-container cache | Unchanged. Write happens on the dashboard container; the hook container's `BearerCredentialProvider` 5-min TTL cache self-heals. Same as today's self-serve write. |

## Architecture

### 1. Endpoint — parameterize `/api/byot` (`src/server-dashboard.ts`)

The handler currently uses `principal.userId` directly. Introduce a
`targetOwner` resolver shared by all three methods:

```ts
// admin may target another user; everyone else is locked to self
const requested = /* GET: url query ?ownerSub; POST/DELETE: body.ownerSub */;
const targetOwner = principal.isAdmin && requested
  ? requested
  : principal.userId;
const actingOnBehalf = targetOwner !== principal.userId; // implies isAdmin
```

- **GET `/api/byot?ownerSub=<sub>`** → `byotService.getStatus(targetOwner)`.
  Non-admin: query param ignored, always self.
- **POST `/api/byot`** `{ token, region, ownerSub? }` →
  `byotService.validateAndStore(targetOwner, token, region, actor?)`.
  Reuses the existing inner-`try` body parse (never logs a pasted token)
  and the existing region regex + probe-failure response shape.
- **DELETE `/api/byot`** `{ ownerSub? }` → `byotService.remove(targetOwner, actor?)`.
  Body is currently empty on DELETE; parse it leniently (missing/blank body
  ⇒ self).

**Known-owner guard.** When `actingOnBehalf`, validate `targetOwner`
against the set of known API-key owners before any store/probe work:

```ts
if (actingOnBehalf && !(await isKnownKeyOwner(targetOwner))) {
  return json(res, 404, { error: "Unknown user" });
}
```

`isKnownKeyOwner(sub)` is satisfied by the existing `apiKeys` store —
prefer `apiKeys.listByOwner(sub)` (cheap, indexed by owner) and treat a
non-empty result as "known". Falls back gracefully if `listByOwner` is
unavailable in a given store impl (then derive from the same `listAll`
the picker uses). This keeps the guard off the `Scan` path.

`actor` (passed only when `actingOnBehalf`):
`{ adminSub: principal.userId, adminEmail: principal.email }`.

### 2. User picker — reuse `/api/keys` (`src/web/dashboard.html`)

No new endpoint. The admin BYOT panel calls the existing admin
`/api/keys` GET (returns `redactKey` shape with `ownerSub` + `ownerEmail`),
dedupes by `ownerSub`, and renders a `<select>` labeled
`ownerEmail || "(no email)"` with the `ownerSub` as the option value (and
a short `sub` suffix shown for disambiguation when emails collide/empty).
Selecting an option calls `GET /api/byot?ownerSub=<sub>` to load that
user's status into the admin status area.

### 3. Data model — audit fields (`src/byot/types.ts`)

Add three optional fields to **`ByotConfigRecord`** (persisted) and
**`ByotConfigStatusView`** (non-sensitive view):

```ts
setByAdminSub?: string | null;
setByAdminEmail?: string | null;
setByAdminAt?: string | null;  // ISO timestamp
```

- Stored in `jaid-byot` alongside the existing fields; `DynamoByotStore`
  marshals/unmarshals them with the rest (no schema migration — absent on
  legacy rows, read as `null`).
- Exposed through `ByotService.getStatus` in the status view. **Never**
  carries the token or ciphertext (unchanged invariant).

### 4. Service layer — optional actor (`src/byot/byot-service.ts`)

`validateAndStore` and `remove` gain an optional `actor`:

```ts
type ByotActor = { adminSub: string; adminEmail: string | null };

async validateAndStore(
  ownerSub: string, token: string, region: string,
  actor?: ByotActor,
): Promise<{ stored: boolean; probe: ProbeResult }>;

async remove(ownerSub: string, actor?: ByotActor): Promise<void>;
```

- **`validateAndStore`**: probe unchanged. When building the record:
  - `actor` present ⇒ `setByAdminSub/Email = actor.*`, `setByAdminAt = now`.
  - `actor` absent (self-write) ⇒ all three set to `null` (this is what
    clears a prior admin stamp when the user reclaims the token).
  - `createdAt` preserved from `existing` as today.
- **`remove`**: deletes the row as today. `actor` is accepted for symmetry
  and audit logging; since the row is deleted there is no stamp to keep.
  (A cleared token has no status to annotate — the user/admin just sees
  "not configured".)
- `onChange?.(ownerSub)` fires with the **target** owner, as today.

`getStatus(ownerSub)` is already parameterized — no signature change;
just returns the new fields.

### 5. Admin UI — BYOT tab (`src/web/dashboard.html`)

An **admin-only** panel in `#tab-byot`, rendered only when
`window.__dreddIsAdmin` / the whoami `isAdmin` flag is set (same gate the
keys/logs/mode admin affordances use):

- A user `<select>` (populated per §2) + a "Load" affordance.
- A status area mirroring `renderByot()` for the selected user: provider,
  region, `last4`, `status`, validation/fallback timestamps, and a
  **"Managed by `<setByAdminEmail>` on `<setByAdminAt>`"** line when the
  stamp is present.
- The same token (`password`) + region `<select>` form, wired to POST with
  `ownerSub` = selected user. Button label "Set / Replace token".
- A "Remove token" button → DELETE with `ownerSub` = selected user.

Implement as new functions (`loadAdminByot`, `renderAdminByot`,
`saveAdminByot`, `removeAdminByot`) parallel to the existing self
functions; reuse `dreddFetch` and the existing region option list.

### 6. User-side disclosure (`src/web/dashboard.html`, `renderByot`)

In the existing self `renderByot()`, when the status carries
`setByAdminEmail`, render a note in the status area:

> "This token was configured by an administrator (`<email>`) on `<date>`."

The user's existing Set/Replace and Remove controls are unchanged and
still work — replacing clears the stamp (§4), removing deletes the row.

## Edge cases & security

- **Non-admin passes `ownerSub`** → ignored; operates on self only.
- **Admin targets unknown sub** → 404 before any probe/store.
- **Token never logged or echoed** — reuse the existing inner-`try` body
  parse on POST; status view stays ciphertext/token-free.
- **Probe** runs against the supplied token+region as today; partial
  failure returns `{ failures }` and stores nothing.
- **User overwrites admin-set token** → admin stamp cleared (self-write
  path nulls the fields).
- **Cross-container cache (existing behavior, unchanged):** the dashboard
  write + `onChange` only invalidate the dashboard process; the hook
  container's `BearerCredentialProvider` cache (5-min TTL) self-heals.
  No cross-container invalidation is added here.
- **`DREDD_BYOT_ENABLED`** still gates only the hot-path resolver. This
  feature is entirely on the dashboard write/read path and works
  regardless of the flag, exactly like the self-serve write path.

## Testing

Extend the existing BYOT test surface (all `npx tsx`):

- **`test_byot_store.ts`** — `ByotConfigRecord` round-trips the three
  `setByAdmin*` fields (InMemory + Dynamo marshalling); legacy rows
  without them read as `null`.
- **`test_byot_pipeline.ts`** (service round-trip):
  - admin actor write stamps `setByAdmin*`;
  - subsequent **self** write (no actor) clears them to `null`;
  - `remove` deletes; `getStatus` reflects each transition.
- **Endpoint authz** (extend the service/pipeline test or add a focused
  handler test):
  - non-admin supplying `ownerSub` operates on self (param ignored);
  - admin set/get/delete against a known target succeeds;
  - admin targeting an unknown sub → 404.
- **UI** — manual (consistent with the existing BYOT tab; not unit-tested).

## Out of scope

- Cross-container cache invalidation (pre-existing behavior; the 5-min
  TTL is the accepted bound).
- Bulk / org-wide token assignment (one target user at a time).
- Targeting users who have never provisioned an API key (picker is the
  only entry point; the known-owner guard enforces it).
- Notifying the user out-of-band (email/Slack) that an admin set their
  token — disclosure is in-dashboard only.
