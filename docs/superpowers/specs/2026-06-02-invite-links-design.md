# Admin invite links — one-time, no-auth onboarding with key + shared BYOT

**Date:** 2026-06-02
**Status:** Design approved, pending spec review
**Author:** brainstormed with Adrian

## Problem

Onboarding a new machine/user onto the prod Dredd today is self-serve and
multi-step (CLAUDE.md "Integrating another machine"): the user must sign
into the Clerk-gated dashboard, generate their own API key from the API
Keys tab, download the integration bundle from the Integrate tab, and wire
it up. Every one of those surfaces is behind Clerk sign-in.

We want an **admin** to onboard someone with a single artifact: generate a
**one-time, no-auth invite link**, associate it with an **email address**,
and optionally **allocate an existing (shared) Bedrock token** so the
invitee's sessions run on that token. The invitee opens the link, clicks
once, and receives their Dredd API key plus a ready-to-install bundle —
without ever signing into the dashboard.

This is intrinsically sensitive: a no-auth URL that mints a live API key.
The design treats the link as a bearer secret throughout.

## Decisions

| Question | Decision |
|---|---|
| Invited-user identity | **Synthetic email-derived `ownerSub`** — `syntheticSubForEmail(email)`. The invited user never needs a Clerk account to be judged. |
| Reconciliation on later Clerk sign-in | **Read-path OR-match, no data migration.** The dashboard matches a signed-in principal's sessions/keys/BYOT on **both** `principal.userId` **and** `syntheticSubForEmail(principal.email)`. The hot path always uses the email-sub (stamped via the key), so no rows are ever rewritten. |
| BYOT allocation | **Shared/pooled token by reference.** A `SHARED#<poolId>` token is referenced by the invitee's per-user BYOT row (`provider: "bedrock-bearer-ref"`). Rotate once → applies to all referencing invitees. |
| Reference depth | **Exactly one hop.** A reference may not point at another reference (guarded) — no cycles, no fan-out. |
| Link payload | **Install page + pre-keyed bundle.** Redemption reveals the key once and serves an integration bundle with the key baked into a `dredd/api-key` file. |
| Token transport | **URL fragment** (`/invite#<token>`). The fragment is never sent to the server, so the token can't land in `[REQ]` access logs or the `Referer` header. The page reads it from `location.hash`. |
| Peek vs consume | **Peek validates without consuming; redeem consumes.** `GET /invite` serves a static page (no token in the request); `POST /api/invite/peek` validates; `POST /api/invite/redeem` (the deliberate button-press) is the single-use consume. Link-preview bots that fetch the page never see the fragment and never burn the invite. |
| Default expiry | **1 hour** (admin-settable per invite). |
| Single-use | Enforced by a DynamoDB conditional `pending → redeemed` flip; the losing racer gets a generic failure. |
| Token at rest | **Hashed** (SHA-256). Plaintext token exists only in the URL. |
| Hosting | Admin generate + redemption served by the **dashboard** role (owns the bundle builder, key store writes, and HTML). The **hook** role is unchanged except for the BYOT reference-follow. |
| Hot-path BYOT activation | Behind the existing `DREDD_BYOT_ENABLED` flag. Storage + admin CRUD + dashboard status work regardless. |
| Rollout | **Phased, flag-gated**, matching every prior Dredd feature. |

## Phasing

1. **Phase A — Storage + admin generate.** `jaid-invites` table, `InviteStore`, admin `POST/GET/DELETE /api/invites`, shared-token storage + admin CRUD. Invites can be created/listed but not redeemed.
2. **Phase B — Redemption.** Public `GET /invite/<token>` (peek) + `POST /api/invite/redeem` (consume → provision key + BYOT reference + pre-keyed bundle).
3. **Phase C — Hot-path BYOT reference resolution.** One-hop follow in `BearerCredentialProvider`, gated by `DREDD_BYOT_ENABLED`.
4. **Phase D — Identity reconciliation** in the dashboard read-path (match both subs).

Phases A–B are the functional core. C activates shared-token billing on the
hot path. D is a viewing convenience that can land last.

## Architecture

### 1. Synthetic owner identity (`src/owner-identity.ts`)

```
syntheticSubForEmail(email) = "invite:" + sha256(lowercase(trim(email))).slice(0, 32)
```

- Deterministic, no PII in the sub, collision-resistant.
- The redemption-provisioned key carries `ownerSub = syntheticSubForEmail(email)`, `ownerEmail = email`, `keyType = "invited"`.
- All the invited user's sessions inherit this sub at `/intent` — permanently. The Clerk userId only ever matters for dashboard *viewing*.
- Exports a helper `ownerSubsForPrincipal(principal)` → `[principal.userId, syntheticSubForEmail(principal.email)]` (deduped, email-sub omitted if email empty) for the Phase-D read-path match.

### 2. Invite storage

**New `jaid-invites` DynamoDB table** (`terraform/jaid-invites.tf`): PAY_PER_REQUEST, SSE via `var.sse_kms_key_arn`, PITR, TTL on `ttl`.

Item shape:
- `pk = INVITE#<tokenHash>` — token stored hashed (SHA-256); plaintext only in the URL.
- `email`, `status` (`pending | redeemed | revoked`), `createdBySub`, `createdByEmail`, `createdAt`, `expiresAt` (epoch s), `ttl` (epoch s, ~7d past expiry so redeemed/expired rows linger briefly for the admin list then self-delete), `sharedTokenId?`, `redeemedAt?`, `resultingKeyHash?`, `resultingOwnerSub?`.
- **GSI1** (`gsi1pk = "INVITE"`, `gsi1sk = createdAt`) set on every item for the admin list view — mirrors the `jaid-sessions` list-GSI pattern.

**`src/invite-store.ts`** — `InviteStore` interface + `InMemoryInviteStore`:
```
createInvite(input): Promise<{ record: InviteRecord; plaintextToken: string }>   // hashes + stores, returns token once
findByToken(plaintextToken): Promise<InviteRecord | null>                         // hash + lookup (peek)
consume(plaintextToken, result): Promise<InviteRecord | null>                     // conditional pending→redeemed; null if lost/invalid
listAll(limit?): Promise<InviteRecord[]>                                          // GSI1 query, admin
revoke(tokenHash, by): Promise<boolean>
```
Token generation: 32 bytes `base64url`. Hashing reuses the api-key `hashKey` helper (or a local equivalent) for consistency.

**`src/dynamo-invite-store.ts`** — `DynamoInviteStore`. `consume` uses a conditional `UpdateItem` (`ConditionExpression: status = "pending" AND expiresAt > :now`) — this is the atomic single-use lock.

A negative-lookup tombstone cache (reuse the api-key 30s-tombstone pattern, in `CachedInviteStore` or inline) caps brute-force probing of `findByToken`.

### 3. Shared (pooled) tokens — extend BYOT

Reuse `jaid-byot` + its KMS/crypto. New partition: `pk = SHARED#<poolId>, sk = TOKEN`, holding `{ name, region, ciphertext, last4, status }`.

`src/byot/types.ts` gains:
- A reference record variant on `ByotConfigRecord`: `provider: "bedrock-bearer-ref"` with `refId: string` (the `SHARED#<poolId>` pk) and **no** `ciphertext`/`region` of its own.
- A `SharedTokenRecord` type (or reuse `ByotConfigRecord` under the `SHARED#` pk).

`src/byot/byot-service.ts` gains shared-token operations: `createShared(name, token, region)` (capability-probe → encrypt → store), `listShared()` (status view, never the token; includes a referencing-invite count), `removeShared(poolId)`, `rotateShared(poolId, token)`. Encryption context for a shared row uses its own pk (`SHARED#<poolId>`) so rotation keeps the context stable.

### 4. One-hop reference resolution (`src/byot/credential-provider.ts`)

`BearerCredentialProvider.resolve(ownerSub)` today reads the row and decrypts when `provider === "bedrock-bearer"`. Change:

```
const rec = await this.store.get(ownerSub);
if (rec?.provider === "bedrock-bearer") {              // own token (unchanged)
  token = await decrypt(rec.ciphertext, { ownerSub });
  auth  = { kind: "bearer", token, region: rec.region };
} else if (rec?.provider === "bedrock-bearer-ref") {   // shared/pool (new)
  const shared = await this.store.get(rec.refId);      // exactly one hop
  if (shared?.provider === "bedrock-bearer") {         // refId must NOT be another ref
    token = await decrypt(shared.ciphertext, { ownerSub: rec.refId });
    auth  = { kind: "bearer", token, region: shared.region };
  }
}
```

- One hop only; a `refId` resolving to another `*-ref` is ignored (→ default).
- Decryption context uses the **shared** row's owner (`rec.refId`), matching how it was encrypted.
- The 5-minute in-process cache still keys on the invitee's `ownerSub`.
- Fail-soft preserved: any missing/garbled row → `{kind:"default"}`, logged not thrown.
- Gated by `DREDD_BYOT_ENABLED` exactly as today.

### 5. Pre-keyed bundle (`src/integration-bundle.ts`)

Add an optional `apiKey?: string` to the bundle builder:
- When present, add a `dredd/api-key` file (mode `0600`) containing the plaintext key, and rewrite README **step 1** from "generate a key" to "your key is already in `dredd/api-key` — copy it to `~/.claude/dredd/api-key` (chmod 600)." The `claude-install-prompt.txt` path still works.
- `DREDD_URL` is baked into the hook by `buildBakedHook` unchanged.
- The keyed bundle is built **only** transiently at redemption — never written to disk or logged. The redemption page warns the download is a secret.

### 6. Endpoints

**Admin-gated** (`requireClerkAuth` + `isAdmin`) on the dashboard:

| Route | Purpose |
|---|---|
| `POST /api/invites` | body `{ email, expiresInHours?, sharedTokenId? }` → create; returns the one-time URL (plaintext token shown once) |
| `GET /api/invites` | admin list (GSI1) |
| `DELETE /api/invites/:id` | revoke a pending invite (`:id` = tokenHash) |
| `POST /api/shared-tokens` | `{ name, token, region }` → probe + store |
| `GET /api/shared-tokens` | list status views + referencing-invite counts |
| `DELETE /api/shared-tokens/:id` | delete (confirm if referenced) |

**Public** (registered before the Clerk gate, alongside `/health`):

| Route | Purpose |
|---|---|
| `GET /invite` | Serves the standalone redemption HTML page. **No token in the request** — it rides in the URL fragment and is read client-side. |
| `POST /api/invite/peek` | Non-consuming validate (token in body) → `{ valid, email, expiresAt }` or a generic invalid. Renders the page state. |
| `POST /api/invite/redeem` | **Consume** — single-use (token in body); the deliberate button-press. |

Per-IP rate limit on `/api/invite/*` (reuse `getClientIp()` + the `[REQ]` logging already in `server-core.ts`). The `[REQ]` line logs the path only — with fragment transport the token never reaches it.

### 7. Redemption flow (`src/invite-service.ts` `redeemInvite`, atomic)

The token arrives in the POST body (the page read it from `location.hash`).

1. Look up token by hash; reject if missing/expired/redeemed → **one generic message** ("invalid or expired"), no enumeration.
2. Conditional flip `pending → redeemed` (the single-use lock). A racing second POST loses and gets the generic failure.
3. Generate the API key: `ownerSub = syntheticSubForEmail(email)`, `ownerEmail = email`, `keyType = "invited"`.
4. If `sharedTokenId` set, write the invitee's BYOT **reference** row under that sub (`provider: "bedrock-bearer-ref"`, `refId = SHARED#<sharedTokenId>`).
5. Stamp `resultingKeyHash` / `resultingOwnerSub` / `redeemedAt` onto the invite row.
6. Build the **pre-keyed bundle** in memory; return `{ plaintextKey, bundleBase64, dreddUrl }` in the single response. The page renders the key once and offers the bundle as a client-side Blob download. Nothing transient is persisted.

### 8. Dashboard UI (`src/web/dashboard.html`)

- **Invites tab** (admin-only): generate form (email; expiry hours, default **1**; optional shared-token dropdown) → shows the one-time URL with Copy + "valid 1 hour, shown once" warning. Table below: email · status chip · created · expires · revoke. Follows the API Keys / BYOT tab patterns; added to the admin-only tab list (`KNOWN_TABS`).
- **Shared tokens** section (in the Invites tab): create (name, paste token, region) → probe → store; list with `last4`/region/status and **"N invites reference this"**; rotate/delete with a confirm when referenced.
- **Redemption page**: standalone minimal HTML from `GET /invite` (not the gated dashboard shell). The page JS reads the token from `location.hash`, calls `POST /api/invite/peek` to render "invited as `<email>`, valid until `<time>`", then on the **Reveal my key & download** button calls `POST /api/invite/redeem` (consume) → key (copy) + bundle download + the 3 install steps inlined (the Integrate tab is unreachable to an unauthenticated invitee).

## Security model & failure modes

| Threat | Control |
|---|---|
| Link leaks before user clicks | Single-use + 1h default expiry. **Residual, documented:** whoever POSTs first wins; if redeemed by an attacker, the user is locked out and the admin re-invites. Intrinsic to no-auth one-time links. |
| Link-preview bots / prefetch | Token rides in the URL **fragment**, never sent on the `GET /invite` fetch; consume is a separate `POST`. Bots neither see the token nor burn the invite. |
| Token in logs / `Referer` | Fragment transport keeps the token out of server access logs (`[REQ]` logs the path only) and out of any `Referer` header on outbound page resources. |
| Token guessing / enumeration | 32-byte `base64url`, hashed at rest; one generic redemption-failure message; negative-lookup tombstone cache. |
| Double-spend race | DynamoDB conditional `pending → redeemed`; key minted only after the flip. |
| Pre-keyed bundle = secret at rest | Built transiently, never stored/logged; `api-key` file mode `0600`; page warns. |
| Public-endpoint abuse | Per-IP rate limit + existing ALB access logs. |
| Generation authority | Admin-only Clerk gate on `/api/invites` + `/api/shared-tokens`. |
| Post-redemption revocation | Resulting key revocable from the API Keys tab (invite stores `resultingKeyHash`). Pending invites revocable via `DELETE`. |
| Shared-token blast radius | Rotate/delete affects all referencing invitees; UI surfaces "N invites reference this" before destructive actions. |

**Fail-soft everywhere** (matching the codebase): redemption store/KMS errors → 500 with generic copy and no partial provisioning side effects (key generation is step 3, only after the lock in step 2); BYOT resolution errors → platform role; an expired-but-unswept invite is rejected by the `expiresAt` check before TTL deletes it.

## Module boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `owner-identity.ts` | email → synthetic sub; principal → sub set | (pure) |
| `invite-store.ts` / `dynamo-invite-store.ts` | persist/hash/single-use/TTL invites | DynamoDB |
| `invite-service.ts` | create/list/revoke/redeem orchestration | invite-store, api-key-store, byot-service, integration-bundle, owner-identity |
| `byot-service.ts` (extended) | shared-token CRUD + reference write | byot-store, crypto, capability-probe |
| `credential-provider.ts` (extended) | one-hop reference resolve | byot-store, crypto |
| `integration-bundle.ts` (extended) | optional key-baked bundle | hook-bake |
| dashboard routes | admin generate/list/revoke + public peek/redeem | invite-service, byot-service |

`invite-service` is the only new unit that fans across stores; everything
else stays single-purpose and independently testable.

## Test surface (`hooks/tests/`, `npx tsx`)

- `test_invite_store.ts` — hash / single-use / TTL / expiry round-trip (in-memory + Dynamo-shape conditional).
- `test_invite_redeem.ts` — atomic redeem: key minted under the right sub; BYOT reference written; double-redeem race loses; expired/revoked rejected; generic failure copy.
- `test_owner_identity.ts` — `syntheticSubForEmail` determinism + `ownerSubsForPrincipal` dedupe/empty-email handling.
- `test_byot_reference.ts` — one-hop follow; double-hop guard (`ref → ref` ignored); fail-soft on missing shared row; cache keying.
- `test_bundle_prekeyed.ts` — bundle includes `dredd/api-key` (mode 0600) + rewritten README only when `apiKey` passed; absent otherwise.
- `test_invite_reconcile.ts` — Phase D: a signed-in Clerk principal matches sessions/keys under both subs.

## Out of scope

- Emailing the link (admin copies the URL and delivers it out-of-band).
- Pre-creating Clerk users / Clerk-backed invitations.
- Rewriting historical `ownerSub` rows (reconciliation is read-path only).
- Multi-use invites / seat counts (single-use only).
- Self-service invite generation by non-admins.
