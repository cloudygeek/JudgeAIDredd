# BYOT — Bring Your Own Token (per-user Bedrock credentials for the judge)

**Date:** 2026-05-26
**Status:** Design approved, pending spec review
**Author:** brainstormed with Adrian

## Problem

Today every Bedrock call the pipeline makes — the LLM judge, the intent
classifier, and the drift-detector embeddings — authenticates with the
single Fargate task IAM role (`bedrock-client.ts` → `clientFor(region)`,
a module-level singleton). All model usage lands on the platform's AWS
bill, with no per-user isolation.

We want a user to be able to supply their own Bedrock credentials so that
the Bedrock calls made on behalf of *their* sessions run on *their* AWS
account. First credential form is an Amazon Bedrock bearer **API key**;
the design must leave a clean seam for IAM role-assumption later.

## Decisions

| Question | Decision |
|---|---|
| Credential form | Bedrock bearer API key now; pluggable `CredentialProvider` so IAM role-assumption can be added with no call-site churn. |
| Scope | **All per-session Bedrock calls** (judge, classifier, drift embeddings) use the user's token when configured. The one-time startup connectivity preflight stays on platform creds. |
| Failure mode at call time | **Fail-soft to platform creds** — retry once on the Fargate role, keep protecting the session, log + surface a dashboard warning. |
| Storage | New `jaid-byot` DynamoDB table; token encrypted with the existing SSE KMS key (direct KMS Encrypt/Decrypt, < 4 KB). |
| Region/model | Store **token + region**. Models stay on the platform-pinned IDs (`JUDGE_MODEL`, `EMBEDDING_MODEL`). |
| Validation on save | Probe **every distinct model ID** the per-session pipeline will invoke (judge via Converse, embedding via InvokeModel, classifier if a distinct model) in the chosen region. Store only if all pass. |
| Threading | Explicit `auth: BedrockAuth` parameter (no ambient/global state). |
| Granularity | Per-user (`ownerSub`). One BYOT config per Clerk identity. |
| Rollout | `DREDD_BYOT_ENABLED` flag gates the hot-path resolver; store + dashboard work regardless so the write path can soak first. |

## Architecture

### 1. Credential model + provider abstraction — `src/byot/credential-provider.ts`

```ts
export type BedrockAuth =
  | { kind: "default" }                                  // platform Fargate role (singleton client)
  | { kind: "bearer"; token: string; region: string }
  // future: | { kind: "assume-role"; roleArn: string; externalId: string; region: string }

export interface CredentialProvider {
  /** Resolve the BedrockAuth for a session owner. Returns {kind:"default"}
   *  when nothing is configured, the rollout flag is off, or decryption fails. */
  resolve(ownerSub: string | null | undefined): Promise<BedrockAuth>;
}
```

- `BearerCredentialProvider` reads the cached/decrypted token+region for the
  owner and returns `{ kind: "bearer", ... }`.
- The future `AssumeRoleCredentialProvider` mints short-lived STS creds
  behind the same `resolve()` seam — `BedrockAuth` gains an `assume-role`
  variant and `bedrock-client` learns to build a client from it; nothing
  else changes.
- A `DefaultCredentialProvider` (always returns `{kind:"default"}`) is the
  no-op used when `DREDD_BYOT_ENABLED=false`.

### 2. Storage — `jaid-byot` table + stores

Files mirror the existing per-user store trio:
- `src/byot-store.ts` — `ByotStore` interface + `InMemoryByotStore`.
- `src/dynamo-byot-store.ts` — `DynamoByotStore` against `jaid-byot`.
- `src/cached-byot-store.ts` — write-through + short-TTL read cache of the
  **decrypted** `BedrockAuth`, keyed by `ownerSub`, invalidated on write.
  Mirrors `cached-api-key-store.ts`. Avoids a KMS Decrypt on every
  `/evaluate`.

**Item shape** (one row per user):
- `pk = USER#<ownerSub>`, `sk = BYOT`
- `provider` — `"bedrock-bearer"` (discriminator for future forms)
- `region` — validated AWS region
- `ciphertext` — base64 KMS-encrypted token
- `last4` — last 4 chars of the plaintext token, for display only
- `status` — `"active" | "validation-failed" | "error"`
- `createdAt`, `updatedAt`, `lastValidatedAt`

**Encryption.** Direct KMS `Encrypt`/`Decrypt` against the existing SSE KMS
key (`sse_kms_key_arn`). A bearer token is well under the 4 KB KMS limit,
so no envelope/data-key machinery is needed. Pass
`EncryptionContext = { ownerSub }` on both Encrypt and Decrypt so a
ciphertext can only be decrypted in the context of its owner. The plaintext
token is never logged, never returned by any read endpoint, and redacted
from any surfaced error.

### 3. `bedrock-client.ts` changes

- `bedrockChat(systemPrompt, userMessage, modelId, effort, images, caller, auth?: BedrockAuth)`
- `bedrockEmbed(texts, modelId, region, auth?: BedrockAuth)`
- `clientFor(region, auth?)` → cache key `${region}#${authFp}` where
  `authFp = "default"` or a SHA-256 prefix of the bearer token. Bound the
  client map with a small LRU so per-user clients don't grow without limit.
- **Bearer client construction** uses per-client token config. The
  `AWS_BEARER_TOKEN_BEDROCK` environment variable is process-wide and
  therefore **not** multi-tenant-safe — the exact SDK knob for per-client
  bearer auth (token provider + `httpBearerAuth` auth scheme) is pinned
  during implementation against the installed `@aws-sdk/client-bedrock-runtime`.
- **Fail-soft retry lives here.** If `auth.kind !== "default"` and the call
  throws an auth / credential / throttling error, retry once with
  `{kind:"default"}` and set a `byotFallback: { reason }` field on the
  return value so the caller can record telemetry. Errors unrelated to
  auth (e.g. malformed request) propagate as today.

### 4. Threading through the pipeline

`PreToolInterceptor.evaluate(...)` gains a `bedrockAuth?: BedrockAuth`
parameter, forwarded to:
- `this.judge.evaluate(..., bedrockAuth)` → `IntentJudge.evaluate` gains
  `auth?` → passed to `bedrockChat`.
- the drift-detector embed calls and the classifier — `embedAny(text,
  model, auth?)` and the classifier's `bedrockChat` gain `auth?`.

This is the exact flow `userPermissions` and `priorApprovals` already use:
the handler resolves cross-session data from the session's `ownerSub` and
passes it down. No ambient state.

### 5. Resolution point

The `/evaluate` handler (`server-hook.ts`) resolves
`bedrockAuth = await byotProvider.resolve(session.ownerSub)` (cached)
before calling `interceptor.evaluate(...)`. No config / flag off →
`{kind:"default"}` and behaviour is identical to today.

### 6. Dashboard write path + UI (dashboard role)

New **BYOT** section near the API Keys tab in `src/web/dashboard.html`.

**UI states (non-sensitive only):**
- *Not configured* — input for the bearer token + a region selector, a
  "Validate & save" button.
- *Configured* — shows `provider`, `region`, masked token (`••••last4`),
  `status` (validated ✓ / validation-failed ⚠ / error), `lastValidatedAt`,
  and **Replace** / **Remove** buttons. The full token is never shown again
  (the user already has it).
- *Fallback banner* — if recent sessions fell back to platform creds, a
  warning: "Your token failed N times recently — falling back to the
  platform. Check the key/region." (driven by the telemetry in §7).

**Endpoints (Clerk-gated, `ownerSub` from the verified JWT):**
- `POST /api/byot` `{ token, region }` →
  1. **Capability probe** (the core of validation): with the supplied token
     + region, confirm the region can serve *every distinct model ID* the
     per-session pipeline will invoke — enumerated from config, not
     hardcoded, so adding a model later automatically extends the probe:
     - judge model — a 1-token `Converse` `"ok"` call on `JUDGE_MODEL`;
     - embedding model — a tiny `InvokeModel` embed on `EMBEDDING_MODEL`;
     - any other distinct model the pipeline uses (e.g. a classifier model
       on a different ID), each via its appropriate API.
     **All** must succeed. If any fails, reject the POST with a structured
     error naming the failing model (e.g.
     `{ error: "region eu-west-2 cannot serve embedding model
     eu.cohere.embed-v4:0: AccessDeniedException" }`) and store nothing.
  2. On full success: KMS-encrypt the token, write the row with
     `status="active"`, `lastValidatedAt=now`, return the non-sensitive
     status shape.
- `GET /api/byot` → status only (`provider`, `region`, `last4`, `status`,
  timestamps). Never the token.
- `DELETE /api/byot` → delete the row + invalidate the cache.

Validation runs with the **user's own bearer token**, so the dashboard task
role needs *no* platform Bedrock permissions for it — the token authorises
the probe calls itself.

### 7. Fallback telemetry

A `byotFallback` returned from `bedrock-client` is recorded on the session
(a META flag/counter + a live-feed event) so the dashboard can surface the
fallback banner in §6. Per-user BYOT-vs-platform cost tagging in
`bedrock-metrics.ts` is a nice-to-have and **deferred**.

### 8. IAM / Terraform

- `terraform/jaid-byot.tf` — new DynamoDB table (`pk`/`sk`), SSE via the KMS
  key, no TTL (persistent until removed). Import-compatible with the
  existing manual-then-import pattern noted in `terraform/README.md`.
- **Dashboard task role** — `dynamodb:GetItem/PutItem/DeleteItem` on
  `jaid-byot`, `kms:Encrypt` + `kms:DescribeKey` on the SSE key. (No
  platform Bedrock perms: the validation probe uses the user's token.)
- **Hook task role** — `dynamodb:GetItem` on `jaid-byot`, `kms:Decrypt` on
  the SSE key.
- **Env vars:** `DYNAMO_BYOT_TABLE_NAME` (default `jaid-byot`),
  `BYOT_KMS_KEY_ID` (reuse `sse_kms_key_arn`), `DREDD_BYOT_ENABLED`
  (default `false` — resolver returns `default` when off; store + dashboard
  unaffected, mirroring the Phase-6 / Phase-8b rollout pattern).

### 9. Error handling

| Failure | Behaviour |
|---|---|
| KMS Decrypt fails on the hot path | Treat as no-BYOT → `{kind:"default"}`, log, mark `status="error"` so the dashboard warns. |
| Bedrock auth / throttle on a BYOT call | Retry once on platform creds (`bedrock-client` fail-soft), record `byotFallback`. |
| Validation probe fails on save | Reject `POST /api/byot` with the failing capability; store nothing. |
| Token anywhere in logs/errors/reads | Redacted / never emitted. |

### 10. Testing

`npx tsx` suites under `hooks/tests/`, following the existing convention:
- `CredentialProvider.resolve` — bearer vs default, flag-off path.
- byot-store round-trip — in-memory + Dynamo path with a mocked KMS
  Encrypt/Decrypt; encryption-context binding to `ownerSub`.
- `clientFor` cache keying — distinct clients per `(region, authFp)`,
  shared client for repeated identical auth, LRU bound.
- fail-soft retry — a stubbed failing bearer client falls back to default
  and records `byotFallback`.
- `/evaluate` threading — a configured BYOT session resolves and threads
  `auth`; flag-off resolves to default.
- dashboard — `POST /api/byot` capability-probe happy path (both models
  pass → stored) and reject path (embedding model fails → not stored,
  structured error).

## Out of scope (YAGNI)

- IAM role-assumption credential form (interface seam only).
- Per-user model overrides (region only; models stay platform-pinned).
- Per-user BYOT-vs-platform cost dashboards (metrics tagging deferred).
- Token rotation / expiry automation.

## Key files touched

| File | Change |
|---|---|
| `src/byot/credential-provider.ts` | **new** — `BedrockAuth`, `CredentialProvider`, bearer + default providers |
| `src/byot-store.ts` / `src/dynamo-byot-store.ts` / `src/cached-byot-store.ts` | **new** — storage trio |
| `src/bedrock-client.ts` | `auth?` params, per-credential client cache, fail-soft retry |
| `src/intent-judge.ts` | `auth?` threaded to `bedrockChat` |
| `src/drift-detector.ts` / classifier | `auth?` threaded to embed/chat |
| `src/pretool-interceptor.ts` | `bedrockAuth?` param on `evaluate`, forwarded |
| `src/server-hook.ts` | resolve `bedrockAuth` in `/evaluate`; record `byotFallback` |
| `src/server-dashboard.ts` | `POST/GET/DELETE /api/byot`, capability probe |
| `src/web/dashboard.html` | BYOT section (store + non-sensitive status + fallback banner) |
| `terraform/jaid-byot.tf`, `terraform/iam.tf`, `terraform/variables.tf` | table + IAM + env |
| `hooks/tests/test_byot_*.ts` | test suites |
