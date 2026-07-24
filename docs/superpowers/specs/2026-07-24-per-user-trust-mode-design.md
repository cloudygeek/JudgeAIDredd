# Per-user Trust Mode — admin-controlled judge bypass

- **Date:** 2026-07-24
- **Status:** Approved (design), pending implementation plan
- **Author:** Adrian Asher (with Claude Code)

## Goal

Let an admin mark a specific user (Clerk `ownerSub`) as **trusted** so that
their tool calls skip the expensive LLM judge, saving Bedrock cost on their
sessions. The judge is the only per-call cost in the pipeline (drift embedding
is the other Bedrock/Ollama call); a trusted user skips both.

This is the "full approval mode" asked for, scoped to **skip only the LLM
judge** — the free deterministic guardrails still enforce.

## Decisions (locked)

| Fork | Choice |
|---|---|
| What is bypassed | **Only the LLM judge (+ drift embedding).** Deterministic hard denies still fire. |
| Trust scope | **Per user (`ownerSub`), all projects.** |
| Who can toggle | **Admin only** (server-enforced via `clerk-auth` `isAdmin`). |
| Storage | **Piggyback `jaid-byot`** with a `sk="TRUST"` item — no new table. |

## Semantics

When user `U` is trusted and `DREDD_TRUST_MODE_ENABLED=true`, `/evaluate` for any
session `U` owns short-circuits to **allow** at the point a call would otherwise
escalate to drift + judge:

- Placement in `pretool-interceptor.ts`: **after** Stage 0 user-deny, Stage 1
  policy, and Stage 1.75 approval lookup; **before** Stage 2 drift (currently
  ~line 596). So:
  - Stage 1 policy `deny` (`rm -rf`, `DENIED_BASH_PATTERNS`, write-then-execute,
    `checkDangerousCombination`) → **still denies** (returns before the short-circuit).
  - Stage 0 user-deny (when `DREDD_USER_PERMISSIONS_ENABLED`) → **still denies**.
  - Stage 1 policy `allow` → allows as today (never reached the judge anyway).
  - Otherwise (the `review`/no-match path that would hit drift+judge) →
    **`stage: "trust-allow"`**, `judgeVerdict: null`, `similarity: null`.
- **Mode-independent:** trust-allow is an allow in interactive / autonomous /
  learn alike (it is not a `!allowed` verdict, so trust-mode disposition doesn't
  apply).
- **Still recorded:** `/track` (PostToolUse) is independent of the `/evaluate`
  decision, so the call is recorded normally; the decision row carries
  `stage: "trust-allow"`.
- **Fail-closed:** any trust-store/resolve error → treated as **not trusted** →
  normal judging. A trust-store outage costs a judge call, never an accidental
  allow-all.
- **Flag off:** the trust store is not read at all (no extra Dynamo cost when
  the feature is disabled).

## Components

| # | File | Change |
|---|---|---|
| 1 | `src/trust-store.ts` *(new)* | `TrustStore` interface + `InMemoryTrustStore`. Record `TrustRecord = { ownerSub, enabled, setBy, setAt, note? }`. Methods: `get(ownerSub)`, `put(record)`, `delete(ownerSub)`. |
| 2 | `src/dynamo-trust-store.ts` *(new)* | `DynamoTrustStore` against `DYNAMO_BYOT_TABLE_NAME`, `pk = USER#<ownerSub>`, `sk = "TRUST"`. Mirrors `DynamoByotStore` marshalling. No KMS (no secret stored). |
| 3 | `src/trust-resolver.ts` *(new)* | `TrustResolver.isTrusted(ownerSub): Promise<boolean>` with a 5-min in-process TTL cache (mirrors BYOT `BearerCredentialProvider`). Fail-soft → `false`. |
| 4 | `src/handlers/evaluate.ts` | When `DREDD_TRUST_MODE_ENABLED`, resolve `trustResolver.isTrusted(ownerForApproval.ownerSub)` and pass `trustedOwner` into `interceptor.evaluate`. Store read skipped when flag off. |
| 5 | `src/pretool-interceptor.ts` | New `trustedOwner?: boolean` param on `evaluate`; short-circuit to `stage:"trust-allow"` in the review fall-through, before Stage 2 drift. |
| 6 | `src/server-dashboard.ts` | `GET /api/trust?ownerSub=…`, `POST /api/trust`, `DELETE /api/trust` — **admin-gated server-side** via `isAdmin`. |
| 7 | `src/web/dashboard.html` | Admin-only **Trust** tab: user selector (reuses the BYOT admin user list) + on/off toggle + current status + optional note + a "this disables the judge for this user in every project" warning. |
| 8 | `src/server-hook.ts` (or `server-core.ts`) | Parse + export `DREDD_TRUST_MODE_ENABLED` (default `false`); construct the `TrustResolver`/store wiring alongside the existing BYOT store construction. |
| 9 | `hooks/tests/test_trust_store.ts` *(new)* | `InMemoryTrustStore` round-trip (get/put/delete). |
| 10 | `hooks/tests/test_trust_pipeline.ts` *(new)* | Interceptor ordering: policy-deny still denies with `trustedOwner=true`; user-deny still denies; a review-path call becomes `trust-allow` with no judge/drift call; flag-off path unchanged. |

## Storage detail

- Table: existing **`jaid-byot`** (`DYNAMO_BYOT_TABLE_NAME`, default `jaid-byot`,
  region `DYNAMO_REGION`).
- Item: `pk = "USER#<ownerSub>"`, `sk = "TRUST"`,
  `{ enabled: boolean, setBy: <adminSub>, setAt: <iso>, note?: string }`.
- **No new terraform, no IAM change:** hook + dashboard roles already hold
  `ByotTableReadWrite` on the `jaid-byot` ARN (hook needs `GetItem`; dashboard
  needs `GetItem`/`PutItem`/`DeleteItem` — all covered).
- **No KMS:** trust records store no secret, so the BYOT KMS
  encrypt/decrypt path does not apply.
- A separate `DynamoTrustStore` class (not folded into `DynamoByotStore`) keeps
  trust logic and byot-token logic independent while sharing the physical table.

## Data flow

1. Admin → dashboard → **Trust** tab → select user → toggle ON (+ optional note)
   → `POST /api/trust { ownerSub, enabled: true, note }`.
2. Dashboard (admin-gated) writes the `sk="TRUST"` item to `jaid-byot`.
3. User runs Claude Code → PreToolUse → hook → `/evaluate`.
4. `evaluate.ts` resolves owner via `getSessionOwner`; if
   `DREDD_TRUST_MODE_ENABLED`, `trustResolver.isTrusted(ownerSub)` (cached).
5. Interceptor: user-deny + policy-deny still block; otherwise the would-be-judge
   call returns `trust-allow` (no drift, no judge).
6. `/track` records the outcome as usual.
7. Dashboard renders a `trust` chip on the live feed + Tool Calls table (same
   mechanism as the `pattern-trust` chip; the `trust-allow` stage flows through
   existing rendering).

## API (dashboard container, admin-only)

- `GET /api/trust?ownerSub=<sub>` → `{ ownerSub, enabled, setBy, setAt, note }` or
  `{ enabled: false }` when no row.
- `POST /api/trust` body `{ ownerSub, enabled, note? }` → upsert; stamps
  `setBy` = caller's admin sub, `setAt` = now.
- `DELETE /api/trust?ownerSub=<sub>` → remove the row (equivalent to disable).
- All three return `403` for non-admins (server-side `isAdmin`, not just hidden UI).

## Rollout

Ships behind **`DREDD_TRUST_MODE_ENABLED`** (default `false`), exactly like
`DREDD_USER_PERMISSIONS_ENABLED` / `DREDD_BYOT_ENABLED`: UI + storage + dashboard
surfacing work with the flag off; only the hot-path short-circuit is gated. Store
and soak, then flip.

## Error handling & security

- **Fail-closed** on any trust resolve/store error → normal judging.
- **Admin-only**, enforced server-side; enabling trust disables the judge for
  that user across all projects — surfaced with a UI warning and auditable
  (`setBy`/`setAt` on the record, `trust-allow` stage on every affected call).
- Deterministic hard denies (`rm -rf`, dangerous combos, user-deny) still
  enforce — trust is **not** "disable Dredd entirely", and unlike
  `pattern-trust-hard` it does **not** override hard denies (it sits after them).

## Out of scope (YAGNI)

- A "list all currently-trusted users" admin view (would need a table scan / GSI).
  MVP is per-user select → show/set status, matching the BYOT admin panel.
- Per-project or per-API-key trust granularity.
- Auto-expiry / TTL on trust records (BYOT-style: persists until removed).
