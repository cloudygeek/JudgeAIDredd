# BYOT (Bring Your Own Token) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user supply their own Amazon Bedrock bearer API key (+ region) so that every per-session Bedrock call (judge, classifier, drift embeddings) for their sessions runs on their AWS account, with fail-soft to platform creds.

**Architecture:** A pluggable `CredentialProvider.resolve(ownerSub) → BedrockAuth` is consulted in the `/evaluate` handler and threaded as an explicit `auth` param down through the interceptor → judge / drift / embeddings into `bedrock-client.ts`, which builds a per-credential client (bearer auth via the SDK `token` config + `authSchemePreference`). Tokens are stored KMS-encrypted in a new `jaid-byot` DynamoDB table; the dashboard validates a token against every model the pipeline uses before storing it.

**Tech Stack:** TypeScript (ESM, `npx tsx`), `@aws-sdk/client-bedrock-runtime` 3.1045, `@aws-sdk/client-dynamodb` + `lib-dynamodb`, **new** `@aws-sdk/client-kms`, OpenTofu/Terraform, Clerk-gated dashboard.

**Spec:** `docs/superpowers/specs/2026-05-26-byot-bedrock-token-design.md`

---

## File Structure

**New files:**
- `src/byot/types.ts` — `BedrockAuth` union, `ByotConfigRecord`, `ByotConfigStatus`.
- `src/byot/byot-crypto.ts` — `ByotCrypto` interface, `KmsByotCrypto`, `FakeByotCrypto`.
- `src/byot-store.ts` — `ByotStore` interface + `InMemoryByotStore`.
- `src/dynamo-byot-store.ts` — `DynamoByotStore` against `jaid-byot`.
- `src/byot/credential-provider.ts` — `CredentialProvider`, `DefaultCredentialProvider`, `BearerCredentialProvider` (decrypt + cache).
- `src/byot/capability-probe.ts` — `probeRegionCapabilities(token, region, models)`.
- `src/byot/byot-service.ts` — write-path orchestration (validate → encrypt → store; status read; delete; runtime-fallback marker).
- `terraform/jaid-byot.tf` — the table.
- `hooks/tests/test_byot_crypto.ts`, `test_byot_store.ts`, `test_byot_provider.ts`, `test_byot_client.ts`, `test_byot_probe.ts`, `test_byot_pipeline.ts`.

**Modified files:**
- `src/bedrock-client.ts` — `auth?` params, per-credential client cache, fail-soft retry, `noFallback` honouring.
- `src/ollama-client.ts` — `embedAny(texts, model, auth?)`.
- `src/drift-detector.ts` — `auth?` on `registerGoal` / `evaluate`.
- `src/intent-judge.ts` — `auth?` on `evaluate`; `byotFallback?` on `JudgeVerdict`.
- `src/pretool-interceptor.ts` — `bedrockAuth?` param on `evaluate`; `byotFallback?` on `InterceptionResult`; thread to judge/drift/embedAny.
- `src/handlers/evaluate.ts` — resolve `bedrockAuth`; record runtime fallback.
- `src/server-core.ts` — env vars + store/crypto/provider construction.
- `src/server-dashboard.ts` — `POST/GET/DELETE /api/byot`.
- `src/web/dashboard.html` — BYOT UI section + fallback banner.
- `terraform/iam.tf`, `terraform/variables.tf` — IAM statements + env wiring.
- `package.json` — add `@aws-sdk/client-kms`; the pre-commit hook bumps version.

**Spec refinement (§7 telemetry):** runtime fallback is recorded **on the BYOT record itself** (`status="runtime-fallback"`, `lastFallbackAt`, `lastFallbackReason`), surfaced by `GET /api/byot`, rather than on the session. Cleaner — no SessionStore/feed plumbing, and the banner reads from the same place the config status lives. Hook role therefore also needs `dynamodb:UpdateItem` on `jaid-byot`. The decrypted-auth cache is unaffected (status is separate metadata, read fresh by the dashboard container).

---

## Task 1: Add KMS SDK dependency + BYOT env vars

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/server-core.ts` (env var exports near the other `DYNAMO_*` consts ~line 569–630)

- [ ] **Step 1: Install the KMS client**

Run:
```bash
npm install @aws-sdk/client-kms@^3.1045.0
```
Expected: `@aws-sdk/client-kms` appears in `package.json` dependencies; `node -e "require('@aws-sdk/client-kms')"` exits 0.

- [ ] **Step 2: Add BYOT env var exports**

In `src/server-core.ts`, immediately after the `DYNAMO_USER_PERMISSIONS_TABLE_NAME` block (~line 618), add:

```ts
// ---------------------------------------------------------------------------
// BYOT (bring-your-own-token) configuration. jaid-byot holds one
// KMS-encrypted Bedrock bearer token per Clerk user. DREDD_BYOT_ENABLED
// gates the hot-path resolver only — the dashboard write path + storage
// work regardless so the feature can soak before enforcement.
// ---------------------------------------------------------------------------
export const DYNAMO_BYOT_TABLE_NAME =
  process.env.DYNAMO_BYOT_TABLE_NAME ?? "jaid-byot";
export const BYOT_ENABLED = (process.env.DREDD_BYOT_ENABLED ?? "false") === "true";
/** ARN/key-id of the SSE KMS key used to envelope the tokens. Reuses the
 *  stack's existing SSE key by default (set via terraform). */
export const BYOT_KMS_KEY_ID =
  process.env.BYOT_KMS_KEY_ID ?? process.env.SSE_KMS_KEY_ARN ?? "";
```

- [ ] **Step 3: Verify the file still type-checks**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: no new errors referencing `server-core.ts` (pre-existing unrelated errors, if any, unchanged).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/server-core.ts
git commit -m "feat(byot): add KMS SDK dep + BYOT env vars"
```

---

## Task 2: `BedrockAuth` type + shared BYOT types

**Files:**
- Create: `src/byot/types.ts`

- [ ] **Step 1: Write the types**

```ts
// src/byot/types.ts
/**
 * Credential identity passed to bedrock-client per call. `default` =
 * the platform Fargate task role (module-level singleton client).
 * `bearer` = a user-supplied Amazon Bedrock API key bound to a region.
 *
 * Extensible: a future `assume-role` variant slots in here and
 * bedrock-client learns to build a client from it — no call-site churn.
 */
export type BedrockAuth =
  | { kind: "default" }
  | {
      kind: "bearer";
      token: string;
      region: string;
      /** When true, bedrock-client throws on auth failure instead of
       *  falling back to the platform role. Used by the capability
       *  probe so a broken token surfaces instead of being masked. */
      noFallback?: boolean;
    };

export type ByotProvider = "bedrock-bearer";

export type ByotConfigStatus =
  | "active"
  | "validation-failed"
  | "runtime-fallback"
  | "error";

/** Stored row (ciphertext is opaque to the store — crypto lives elsewhere). */
export interface ByotConfigRecord {
  ownerSub: string;
  provider: ByotProvider;
  region: string;
  ciphertext: string;
  last4: string;
  status: ByotConfigStatus;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  lastFallbackAt?: string | null;
  lastFallbackReason?: string | null;
}

/** Non-sensitive projection returned by the dashboard GET — never the token. */
export interface ByotConfigStatusView {
  configured: boolean;
  provider?: ByotProvider;
  region?: string;
  last4?: string;
  status?: ByotConfigStatus;
  createdAt?: string;
  updatedAt?: string;
  lastValidatedAt?: string | null;
  lastFallbackAt?: string | null;
  lastFallbackReason?: string | null;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit 2>&1 | grep "byot/types" || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Commit**

```bash
git add src/byot/types.ts
git commit -m "feat(byot): BedrockAuth + shared BYOT types"
```

---

## Task 3: `ByotCrypto` — KMS encrypt/decrypt + fake for tests

**Files:**
- Create: `src/byot/byot-crypto.ts`
- Test: `hooks/tests/test_byot_crypto.ts`

- [ ] **Step 1: Write the failing test**

```ts
// hooks/tests/test_byot_crypto.ts
// Run: npx tsx hooks/tests/test_byot_crypto.ts
import { FakeByotCrypto } from "../../src/byot/byot-crypto.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const crypto = new FakeByotCrypto();
  const ct = await crypto.encrypt("super-secret-token", { ownerSub: "user_123" });
  ok("ciphertext is not the plaintext", ct !== "super-secret-token");
  const pt = await crypto.decrypt(ct, { ownerSub: "user_123" });
  ok("round-trips back to plaintext", pt === "super-secret-token");

  let threw = false;
  try { await crypto.decrypt(ct, { ownerSub: "someone_else" }); }
  catch { threw = true; }
  ok("decrypt with wrong ownerSub context throws", threw);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx hooks/tests/test_byot_crypto.ts`
Expected: FAIL — cannot find module `byot-crypto.js`.

- [ ] **Step 3: Implement `byot-crypto.ts`**

```ts
// src/byot/byot-crypto.ts
import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
} from "@aws-sdk/client-kms";

/** Encryption context binds a ciphertext to its owner: a blob encrypted
 *  for user A cannot be decrypted in the context of user B. */
export type EncryptionContext = { ownerSub: string };

export interface ByotCrypto {
  encrypt(plaintext: string, ctx: EncryptionContext): Promise<string>;
  decrypt(ciphertext: string, ctx: EncryptionContext): Promise<string>;
}

export interface KmsByotCryptoOptions {
  keyId: string;
  region: string;
  /** Override for tests. */
  client?: KMSClient;
}

/** Direct KMS Encrypt/Decrypt. A bearer token is well under the 4 KB KMS
 *  limit, so no envelope/data-key machinery is needed. */
export class KmsByotCrypto implements ByotCrypto {
  private readonly keyId: string;
  private readonly client: KMSClient;
  constructor(opts: KmsByotCryptoOptions) {
    this.keyId = opts.keyId;
    this.client = opts.client ?? new KMSClient({ region: opts.region });
  }
  async encrypt(plaintext: string, ctx: EncryptionContext): Promise<string> {
    const out = await this.client.send(new EncryptCommand({
      KeyId: this.keyId,
      Plaintext: new TextEncoder().encode(plaintext),
      EncryptionContext: { ownerSub: ctx.ownerSub },
    }));
    return Buffer.from(out.CiphertextBlob as Uint8Array).toString("base64");
  }
  async decrypt(ciphertext: string, ctx: EncryptionContext): Promise<string> {
    const out = await this.client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, "base64"),
      EncryptionContext: { ownerSub: ctx.ownerSub },
    }));
    return new TextDecoder().decode(out.Plaintext as Uint8Array);
  }
}

/** Dev/test crypto: base64 with the encryption context prefixed so a
 *  context mismatch fails the same way KMS would. NOT secure — only used
 *  when no KMS key is configured (local STORE_BACKEND=memory). */
export class FakeByotCrypto implements ByotCrypto {
  async encrypt(plaintext: string, ctx: EncryptionContext): Promise<string> {
    return Buffer.from(`${ctx.ownerSub}::${plaintext}`).toString("base64");
  }
  async decrypt(ciphertext: string, ctx: EncryptionContext): Promise<string> {
    const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
    const sep = decoded.indexOf("::");
    const owner = decoded.slice(0, sep);
    if (owner !== ctx.ownerSub) throw new Error("encryption context mismatch");
    return decoded.slice(sep + 2);
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx tsx hooks/tests/test_byot_crypto.ts`
Expected: `ALL PASS (3/3)`

- [ ] **Step 5: Commit**

```bash
git add src/byot/byot-crypto.ts hooks/tests/test_byot_crypto.ts
git commit -m "feat(byot): ByotCrypto (KMS + fake) with ownerSub encryption context"
```

---

## Task 4: `ByotStore` interface + `InMemoryByotStore`

**Files:**
- Create: `src/byot-store.ts`
- Test: `hooks/tests/test_byot_store.ts`

- [ ] **Step 1: Write the failing test**

```ts
// hooks/tests/test_byot_store.ts
// Run: npx tsx hooks/tests/test_byot_store.ts
import { InMemoryByotStore } from "../../src/byot-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const store = new InMemoryByotStore();
  ok("get on empty returns null", (await store.get("u1")) === null);

  await store.put({
    ownerSub: "u1", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: "CT", last4: "abcd", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
  });
  const r = await store.get("u1");
  ok("get returns the stored record", r?.ciphertext === "CT" && r?.region === "eu-west-2");
  ok("scoped to ownerSub", (await store.get("u2")) === null);

  await store.markRuntimeFallback("u1", "AccessDeniedException", "t1");
  const r2 = await store.get("u1");
  ok("markRuntimeFallback sets status + reason", r2?.status === "runtime-fallback" && r2?.lastFallbackReason === "AccessDeniedException");
  ok("markRuntimeFallback preserves ciphertext", r2?.ciphertext === "CT");

  await store.delete("u1");
  ok("delete removes the row", (await store.get("u1")) === null);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_byot_store.ts`
Expected: FAIL — cannot find module `byot-store.js`.

- [ ] **Step 3: Implement `byot-store.ts`**

```ts
// src/byot-store.ts
import type { ByotConfigRecord, ByotConfigStatus } from "./byot/types.js";

/** Per-user store of the encrypted Bedrock token config. One row per
 *  ownerSub. The store treats `ciphertext` as opaque — crypto lives in
 *  ByotCrypto. See terraform/jaid-byot.tf. */
export interface ByotStore {
  get(ownerSub: string): Promise<ByotConfigRecord | null>;
  put(record: ByotConfigRecord): Promise<void>;
  delete(ownerSub: string): Promise<void>;
  /** Stamp a runtime auth failure onto the record (status +
   *  lastFallbackAt/Reason) without touching the ciphertext. */
  markRuntimeFallback(ownerSub: string, reason: string, at: string): Promise<void>;
}

export class InMemoryByotStore implements ByotStore {
  private readonly rows = new Map<string, ByotConfigRecord>();
  async get(ownerSub: string): Promise<ByotConfigRecord | null> {
    return this.rows.get(ownerSub) ?? null;
  }
  async put(record: ByotConfigRecord): Promise<void> {
    this.rows.set(record.ownerSub, { ...record });
  }
  async delete(ownerSub: string): Promise<void> {
    this.rows.delete(ownerSub);
  }
  async markRuntimeFallback(ownerSub: string, reason: string, at: string): Promise<void> {
    const r = this.rows.get(ownerSub);
    if (!r) return;
    const status: ByotConfigStatus = "runtime-fallback";
    this.rows.set(ownerSub, { ...r, status, lastFallbackAt: at, lastFallbackReason: reason, updatedAt: at });
  }
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_byot_store.ts`
Expected: `ALL PASS (6/6)`

- [ ] **Step 5: Commit**

```bash
git add src/byot-store.ts hooks/tests/test_byot_store.ts
git commit -m "feat(byot): ByotStore interface + InMemoryByotStore"
```

---

## Task 5: `DynamoByotStore`

**Files:**
- Create: `src/dynamo-byot-store.ts`
- Test: extend `hooks/tests/test_byot_store.ts` with an injected fake doc client

- [ ] **Step 1: Add a Dynamo round-trip case to the test (against an injected fake client)**

Append to `main()` in `hooks/tests/test_byot_store.ts`, before the final summary:

```ts
  // DynamoByotStore against an in-memory fake DynamoDBDocumentClient.
  const { DynamoByotStore } = await import("../../src/dynamo-byot-store.js");
  const fakeTable = new Map<string, any>();
  const fakeClient = {
    async send(cmd: any): Promise<any> {
      const name = cmd.constructor.name;
      const key = (k: any) => `${k.pk}|${k.sk}`;
      if (name === "PutCommand") { fakeTable.set(key(cmd.input.Item), cmd.input.Item); return {}; }
      if (name === "GetCommand") { return { Item: fakeTable.get(key(cmd.input.Key)) }; }
      if (name === "DeleteCommand") { fakeTable.delete(key(cmd.input.Key)); return {}; }
      if (name === "UpdateCommand") {
        const item = fakeTable.get(key(cmd.input.Key));
        if (item) {
          item.status = cmd.input.ExpressionAttributeValues[":s"];
          item.lastFallbackAt = cmd.input.ExpressionAttributeValues[":a"];
          item.lastFallbackReason = cmd.input.ExpressionAttributeValues[":r"];
          item.updatedAt = cmd.input.ExpressionAttributeValues[":a"];
        }
        return {};
      }
      throw new Error("unexpected command " + name);
    },
  } as any;
  const dyn = new DynamoByotStore({ tableName: "jaid-byot", region: "eu-west-1", client: fakeClient });
  await dyn.put({
    ownerSub: "d1", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: "CT2", last4: "wxyz", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
  });
  const dr = await dyn.get("d1");
  ok("dynamo round-trips", dr?.ciphertext === "CT2" && dr?.last4 === "wxyz");
  await dyn.markRuntimeFallback("d1", "ThrottlingException", "t9");
  ok("dynamo markRuntimeFallback", (await dyn.get("d1"))?.status === "runtime-fallback");
  await dyn.delete("d1");
  ok("dynamo delete", (await dyn.get("d1")) === null);
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_byot_store.ts`
Expected: FAIL — cannot find module `dynamo-byot-store.js`.

- [ ] **Step 3: Implement `dynamo-byot-store.ts`**

```ts
// src/dynamo-byot-store.ts
/**
 * DynamoDB-backed ByotStore. One row per ownerSub in `jaid-byot`.
 *   pk = USER#<ownerSub>, sk = BYOT
 * See terraform/jaid-byot.tf.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { ByotStore } from "./byot-store.js";
import type { ByotConfigRecord } from "./byot/types.js";

export interface DynamoByotStoreOptions {
  tableName: string;
  region: string;
  /** Override for tests. */
  client?: DynamoDBDocumentClient;
}

const pk = (ownerSub: string) => `USER#${ownerSub}`;
const SK = "BYOT";

function itemToRecord(item: Record<string, any>): ByotConfigRecord {
  return {
    ownerSub: item.ownerSub,
    provider: item.provider,
    region: item.region,
    ciphertext: item.ciphertext,
    last4: item.last4,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastValidatedAt: item.lastValidatedAt ?? null,
    lastFallbackAt: item.lastFallbackAt ?? null,
    lastFallbackReason: item.lastFallbackReason ?? null,
  };
}

export class DynamoByotStore implements ByotStore {
  private readonly tableName: string;
  private readonly doc: DynamoDBDocumentClient;
  constructor(opts: DynamoByotStoreOptions) {
    this.tableName = opts.tableName;
    this.doc = opts.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }));
  }
  async get(ownerSub: string): Promise<ByotConfigRecord | null> {
    const out = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: pk(ownerSub), sk: SK },
    }));
    return out.Item ? itemToRecord(out.Item) : null;
  }
  async put(record: ByotConfigRecord): Promise<void> {
    await this.doc.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: pk(record.ownerSub), sk: SK, ...record },
    }));
  }
  async delete(ownerSub: string): Promise<void> {
    await this.doc.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { pk: pk(ownerSub), sk: SK },
    }));
  }
  async markRuntimeFallback(ownerSub: string, reason: string, at: string): Promise<void> {
    await this.doc.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: pk(ownerSub), sk: SK },
      // Only update an existing row — never resurrect a deleted config.
      ConditionExpression: "attribute_exists(pk)",
      UpdateExpression: "SET #s = :s, lastFallbackAt = :a, lastFallbackReason = :r, updatedAt = :a",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "runtime-fallback", ":a": at, ":r": reason },
    }).catch((err: any) => {
      // A deleted-in-the-meantime config (ConditionalCheckFailed) is fine
      // to swallow — there's nothing to flag.
      if (err?.name !== "ConditionalCheckFailedException") throw err;
    }) as any);
  }
}
```

> Note: the fake client test stub above ignores `ConditionExpression` (it
> only models the happy path), which is fine — the real condition is
> exercised in prod, the test exercises the read/write shape.

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_byot_store.ts`
Expected: `ALL PASS (9/9)`

- [ ] **Step 5: Commit**

```bash
git add src/dynamo-byot-store.ts hooks/tests/test_byot_store.ts
git commit -m "feat(byot): DynamoByotStore against jaid-byot"
```

---

## Task 6: `CredentialProvider` — default + bearer (decrypt + cache)

**Files:**
- Create: `src/byot/credential-provider.ts`
- Test: `hooks/tests/test_byot_provider.ts`

- [ ] **Step 1: Write the failing test**

```ts
// hooks/tests/test_byot_provider.ts
// Run: npx tsx hooks/tests/test_byot_provider.ts
import { InMemoryByotStore } from "../../src/byot-store.js";
import { FakeByotCrypto } from "../../src/byot/byot-crypto.js";
import {
  DefaultCredentialProvider,
  BearerCredentialProvider,
} from "../../src/byot/credential-provider.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const def = new DefaultCredentialProvider();
  ok("default provider always returns {kind:default}", (await def.resolve("u1")).kind === "default");
  ok("default handles null ownerSub", (await def.resolve(null)).kind === "default");

  const store = new InMemoryByotStore();
  const crypto = new FakeByotCrypto();
  const token = "bedrock-api-key-XYZ";
  await store.put({
    ownerSub: "u1", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: await crypto.encrypt(token, { ownerSub: "u1" }),
    last4: token.slice(-4), status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
  });

  let decryptCalls = 0;
  const countingCrypto = {
    encrypt: crypto.encrypt.bind(crypto),
    decrypt: (ct: string, ctx: any) => { decryptCalls++; return crypto.decrypt(ct, ctx); },
  };
  const bearer = new BearerCredentialProvider({ store, crypto: countingCrypto as any, cacheTtlMs: 60_000 });

  const a1 = await bearer.resolve("u1");
  ok("bearer resolves to a bearer auth", a1.kind === "bearer");
  ok("carries token + region", a1.kind === "bearer" && a1.token === token && a1.region === "eu-west-2");

  await bearer.resolve("u1");
  ok("second resolve served from cache (no extra decrypt)", decryptCalls === 1);

  ok("no config → default", (await bearer.resolve("nobody")).kind === "default");

  // decrypt failure → default, not a throw
  await store.put({
    ownerSub: "bad", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: "not-valid-ciphertext-for-bad", last4: "????", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
  });
  ok("decrypt failure fails soft to default", (await bearer.resolve("bad")).kind === "default");

  bearer.invalidate("u1");
  await bearer.resolve("u1");
  ok("invalidate forces a fresh decrypt", decryptCalls === 2);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_byot_provider.ts`
Expected: FAIL — cannot find module `credential-provider.js`.

- [ ] **Step 3: Implement `credential-provider.ts`**

```ts
// src/byot/credential-provider.ts
import type { BedrockAuth } from "./types.js";
import type { ByotStore } from "../byot-store.js";
import type { ByotCrypto } from "./byot-crypto.js";

export interface CredentialProvider {
  /** Resolve the BedrockAuth for a session owner. Always fails soft to
   *  {kind:"default"} — never throws — so a resolver problem can never
   *  break the hot path. */
  resolve(ownerSub: string | null | undefined): Promise<BedrockAuth>;
}

/** Used when DREDD_BYOT_ENABLED=false: every call runs on platform creds. */
export class DefaultCredentialProvider implements CredentialProvider {
  async resolve(): Promise<BedrockAuth> {
    return { kind: "default" };
  }
}

interface CacheEntry { auth: BedrockAuth; expiresAt: number; }

export interface BearerCredentialProviderOptions {
  store: ByotStore;
  crypto: ByotCrypto;
  /** Decrypted-auth cache TTL. Default 5 min (matches cached-api-key-store). */
  cacheTtlMs?: number;
  /** Override for tests. */
  now?: () => number;
}

/** Reads the per-user BYOT row, decrypts the token, returns a bearer
 *  BedrockAuth. Caches the *decrypted* auth in-process so we don't pay a
 *  KMS Decrypt on every /evaluate. */
export class BearerCredentialProvider implements CredentialProvider {
  private readonly store: ByotStore;
  private readonly crypto: ByotCrypto;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: BearerCredentialProviderOptions) {
    this.store = opts.store;
    this.crypto = opts.crypto;
    this.ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  invalidate(ownerSub: string): void {
    this.cache.delete(ownerSub);
  }

  async resolve(ownerSub: string | null | undefined): Promise<BedrockAuth> {
    if (!ownerSub) return { kind: "default" };
    const cached = this.cache.get(ownerSub);
    if (cached && cached.expiresAt > this.now()) return cached.auth;

    let auth: BedrockAuth = { kind: "default" };
    try {
      const rec = await this.store.get(ownerSub);
      if (rec && rec.provider === "bedrock-bearer") {
        const token = await this.crypto.decrypt(rec.ciphertext, { ownerSub });
        auth = { kind: "bearer", token, region: rec.region };
      }
    } catch (err) {
      // Decrypt / store error → fail soft to default. Logged, not thrown.
      console.warn(`[byot] resolve failed for ${ownerSub.substring(0, 8)}: ${(err as Error)?.message ?? err}`);
      auth = { kind: "default" };
    }
    this.cache.set(ownerSub, { auth, expiresAt: this.now() + this.ttl });
    return auth;
  }
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_byot_provider.ts`
Expected: `ALL PASS (9/9)`

- [ ] **Step 5: Commit**

```bash
git add src/byot/credential-provider.ts hooks/tests/test_byot_provider.ts
git commit -m "feat(byot): CredentialProvider (default + bearer with decrypt cache)"
```

---

## Task 7: `bedrock-client` — per-credential client cache + bearer auth

**Files:**
- Modify: `src/bedrock-client.ts` (the `clients` map + `clientFor`, ~line 43–54)
- Test: `hooks/tests/test_byot_client.ts`

- [ ] **Step 1: Write the failing test (client cache keying)**

```ts
// hooks/tests/test_byot_client.ts
// Run: npx tsx hooks/tests/test_byot_client.ts
import { __clientForTest } from "../../src/bedrock-client.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const d1 = __clientForTest("eu-west-2", { kind: "default" });
  const d2 = __clientForTest("eu-west-2", { kind: "default" });
  ok("same region+default → same client instance", d1 === d2);

  const b1 = __clientForTest("eu-west-2", { kind: "bearer", token: "tok-A", region: "eu-west-2" });
  ok("bearer client differs from default", b1 !== d1);

  const b2 = __clientForTest("eu-west-2", { kind: "bearer", token: "tok-A", region: "eu-west-2" });
  ok("same token → same client (cached)", b1 === b2);

  const b3 = __clientForTest("eu-west-2", { kind: "bearer", token: "tok-B", region: "eu-west-2" });
  ok("different token → different client", b3 !== b1);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_byot_client.ts`
Expected: FAIL — `__clientForTest` is not exported.

- [ ] **Step 3: Replace the client cache + `clientFor` in `bedrock-client.ts`**

Add the import at the top (after the existing imports):

```ts
import { createHash } from "node:crypto";
import type { BedrockAuth } from "./byot/types.js";
```

Replace the existing `clients`/`clientFor` block (lines ~43–54):

```ts
// Bounded per-credential client cache. Keyed by `${region}#${authFp}` so
// the platform role and each distinct bearer token get their own client.
// LRU-evicted (delete + reinsert on touch; drop oldest past the cap) so a
// burst of distinct BYOT users can't grow the map without limit.
const MAX_CLIENTS = 200;
const clients = new Map<string, BedrockRuntimeClient>();

function authFingerprint(auth?: BedrockAuth): string {
  if (!auth || auth.kind === "default") return "default";
  // kind === "bearer"
  return "bearer:" + createHash("sha256").update(auth.token).digest("hex").slice(0, 16);
}

/** Region a call should use: a bearer token is bound to its own region;
 *  default creds use the module REGION. */
function regionFor(auth?: BedrockAuth, fallback = REGION): string {
  return auth && auth.kind === "bearer" ? auth.region : fallback;
}

function clientFor(region: string, auth?: BedrockAuth): BedrockRuntimeClient {
  const key = `${region}#${authFingerprint(auth)}`;
  const existing = clients.get(key);
  if (existing) {
    clients.delete(key); clients.set(key, existing); // LRU touch
    return existing;
  }
  let client: BedrockRuntimeClient;
  if (auth && auth.kind === "bearer") {
    // Per-client bearer auth. The bedrock-runtime auth scheme provider
    // lists sigv4 BEFORE bearer for every operation, so setting `token`
    // alone is not enough — platform IAM creds in the chain would win.
    // authSchemePreference forces bearer for this client only. (The
    // process-wide AWS_BEARER_TOKEN_BEDROCK env var is NOT multi-tenant
    // safe, which is why this is per-client config.)
    client = new BedrockRuntimeClient({
      region,
      token: { token: auth.token },
      authSchemePreference: ["httpBearerAuth"],
    });
  } else {
    client = new BedrockRuntimeClient({ region });
  }
  if (clients.size >= MAX_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest !== undefined) clients.delete(oldest);
  }
  clients.set(key, client);
  return client;
}

/** Test-only accessor for the client cache keying. */
export function __clientForTest(region: string, auth?: BedrockAuth): BedrockRuntimeClient {
  return clientFor(region, auth);
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_byot_client.ts`
Expected: `ALL PASS (4/4)`

- [ ] **Step 5: Commit**

```bash
git add src/bedrock-client.ts hooks/tests/test_byot_client.ts
git commit -m "feat(byot): per-credential Bedrock client cache + bearer auth"
```

---

## Task 8: `bedrockChat` — thread `auth`, fail-soft retry, `byotFallback`

**Files:**
- Modify: `src/bedrock-client.ts` (`bedrockChat` signature + send block, ~line 62–152, 210–222)

- [ ] **Step 1: Add an auth-failure classifier (top of file, after `regionFor`)**

```ts
/** Errors that mean "this credential can't make this call" — retry on the
 *  platform role. Throttling/unavailable included per the BYOT fail-soft
 *  decision (keep the judge running on the platform if the user's account
 *  is throttled). Anything else (e.g. a genuine ValidationException from a
 *  malformed request) propagates unchanged. */
const BYOT_FALLBACK_ERRORS = new Set([
  "AccessDeniedException",
  "UnauthorizedException",
  "UnrecognizedClientException",
  "ExpiredTokenException",
  "InvalidSignatureException",
  "ThrottlingException",
  "ThrottledException",
  "ServiceUnavailableException",
  "ServiceQuotaExceededException",
]);
function isByotFallbackError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return BYOT_FALLBACK_ERRORS.has(name);
}
```

- [ ] **Step 2: Change the `bedrockChat` signature**

Add `auth?: BedrockAuth` as the final parameter and `byotFallback?` to the return type:

```ts
export async function bedrockChat(
  systemPrompt: string,
  userMessage: string,
  modelId = MODEL_ID,
  effort?: EffortLevel,
  images?: BedrockImageBlock[],
  caller: BedrockCaller = "unknown",
  auth?: BedrockAuth,
): Promise<{
  content: string;
  thinking: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  hasThinkingBlock: boolean;
  estimatedThinkingTokens: number;
  /** Set when a bearer call failed on an auth/throttle error and we
   *  retried on the platform role. Undefined on the happy path. */
  byotFallback?: { reason: string };
}> {
```

- [ ] **Step 3: Replace the single `.send(...)` (the `const response = await clientFor(REGION).send(...)` block, ~line 150–152) with the fail-soft send**

```ts
  const timeoutMs = parseInt(process.env.BEDROCK_REQUEST_TIMEOUT_MS ?? "120000", 10);

  // Per-attempt fresh abort signal (a reused timeout could be near-expired
  // on the retry). Bearer auth → user's region; default → module REGION.
  const sendWith = (a?: BedrockAuth) =>
    clientFor(regionFor(a), a).send(command, { abortSignal: AbortSignal.timeout(timeoutMs) });

  let response;
  let byotFallback: { reason: string } | undefined;
  try {
    response = await sendWith(auth);
  } catch (err) {
    if (auth && auth.kind === "bearer" && !auth.noFallback && isByotFallbackError(err)) {
      byotFallback = { reason: (err as { name?: string })?.name ?? "byot-error" };
      console.warn(`  [bedrock] BYOT ${caller} call failed (${byotFallback.reason}); falling back to platform creds`);
      response = await sendWith({ kind: "default" });
    } else {
      throw err;
    }
  }
```

- [ ] **Step 4: Add `byotFallback` to the return object (the final `return { ... }`, ~line 210)**

Add this line inside the returned object literal:

```ts
    byotFallback,
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep "bedrock-client" || echo "clean"`
Expected: `clean`

- [ ] **Step 6: Commit**

```bash
git add src/bedrock-client.ts
git commit -m "feat(byot): bedrockChat auth param + fail-soft retry + byotFallback"
```

---

## Task 9: `bedrockEmbed` — thread `auth` + fail-soft

**Files:**
- Modify: `src/bedrock-client.ts` (`bedrockEmbed` + `invokeModel`, ~line 232–263)

- [ ] **Step 1: Change `bedrockEmbed` + `invokeModel` to carry auth**

Replace `bedrockEmbed`'s signature and dispatch:

```ts
export async function bedrockEmbed(
  texts: string[],
  modelId: string,
  region = REGION,
  auth?: BedrockAuth,
): Promise<number[][]> {
  // Bearer token is bound to its own region; otherwise use the passed region.
  const effRegion = auth && auth.kind === "bearer" ? auth.region : region;
  const bare = modelId.replace(/^(?:eu|us|global)\./, "");
  if (bare.startsWith("cohere.embed")) return cohereEmbed(texts, modelId, effRegion, auth);
  if (bare.startsWith("amazon.titan-embed")) return Promise.all(texts.map((t) => titanEmbed(t, modelId, effRegion, auth)));
  if (bare.startsWith("twelvelabs.")) return Promise.all(texts.map((t) => marengoEmbed(t, modelId, effRegion, auth)));
  throw new Error(`Unknown Bedrock embedding model family: ${modelId}`);
}
```

Replace `invokeModel` to accept + fail-soft on auth:

```ts
async function invokeModel(modelId: string, body: object, region: string, auth?: BedrockAuth): Promise<object> {
  const command = new InvokeModelCommand({
    modelId,
    body: new TextEncoder().encode(JSON.stringify(body)),
    contentType: "application/json",
    accept: "application/json",
  });
  const sendWith = (a?: BedrockAuth) => clientFor(regionFor(a, region), a).send(command);
  let response;
  try {
    response = await sendWith(auth);
  } catch (err) {
    if (auth && auth.kind === "bearer" && !auth.noFallback && isByotFallbackError(err)) {
      console.warn(`  [bedrock] BYOT embed call failed (${(err as any)?.name}); falling back to platform creds`);
      response = await sendWith({ kind: "default" });
    } else {
      throw err;
    }
  }
  const bytes = response.body as Uint8Array;
  return JSON.parse(new TextDecoder().decode(bytes));
}
```

Update the three embed helpers to pass `auth` through. Change each signature `(... region: string)` → `(... region: string, auth?: BedrockAuth)` and each `invokeModel(modelId, body, region)` → `invokeModel(modelId, body, region, auth)`:

```ts
async function cohereEmbed(texts: string[], modelId: string, region: string, auth?: BedrockAuth): Promise<number[][]> {
  const resp = (await invokeModel(modelId, { texts, input_type: "search_query" }, region, auth)) as Record<string, unknown>;
  const emb = resp.embeddings as number[][] | { float: number[][] };
  return Array.isArray(emb) ? emb : emb.float;
}
async function titanEmbed(text: string, modelId: string, region: string, auth?: BedrockAuth): Promise<number[]> {
  const resp = (await invokeModel(modelId, { inputText: text }, region, auth)) as { embedding: number[] };
  return resp.embedding;
}
async function marengoEmbed(text: string, modelId: string, region: string, auth?: BedrockAuth): Promise<number[]> {
  const bare = modelId.replace(/^(?:eu|us|global)\./, "");
  const body = bare.includes("marengo-embed-2-7")
    ? { inputType: "text", inputText: text }
    : { inputType: "text", text: { inputText: text } };
  const resp = (await invokeModel(modelId, body, region, auth)) as Record<string, unknown>;
  if (Array.isArray(resp.embedding)) return resp.embedding as number[];
  const data = resp.data as { embedding: number[] }[] | undefined;
  if (data?.[0]?.embedding) return data[0].embedding;
  throw new Error(`Unexpected Marengo response shape: ${JSON.stringify(resp).substring(0, 200)}`);
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep "bedrock-client" || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Commit**

```bash
git add src/bedrock-client.ts
git commit -m "feat(byot): bedrockEmbed auth param + fail-soft"
```

---

## Task 10: `embedAny` — thread `auth`

**Files:**
- Modify: `src/ollama-client.ts` (`embedAny`, ~line 93–103)

- [ ] **Step 1: Add `auth?` and pass it to `bedrockEmbed`**

```ts
export async function embedAny(
  texts: string | string[],
  model: string,
  auth?: import("./byot/types.js").BedrockAuth,
): Promise<number[][]> {
  if (isBedrockModel(model)) {
    const { bedrockEmbed } = await import("./bedrock-client.js");
    const arr = Array.isArray(texts) ? texts : [texts];
    return bedrockEmbed(arr, model, undefined, auth);
  }
  // Ollama path is local — BYOT does not apply.
  return embed(texts, model);
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep "ollama-client" || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Commit**

```bash
git add src/ollama-client.ts
git commit -m "feat(byot): embedAny threads auth to bedrockEmbed"
```

---

## Task 11: `DriftDetector` — thread `auth` through embed calls

**Files:**
- Modify: `src/drift-detector.ts` (`registerGoal` ~line 52, `evaluate` ~line 112)

- [ ] **Step 1: Add `auth?` to `registerGoal` and `evaluate`**

`registerGoal`:

```ts
  async registerGoal(task: string, auth?: import("./byot/types.js").BedrockAuth): Promise<void> {
    const embeddings = await embedAny(task, this.embeddingModel, auth);
    this.goalEmbeddings = [embeddings[0]];
  }
```

`evaluate` — change the signature line and the single `embedAny` call inside it:

```ts
  async evaluate(turnSummary: string, auth?: import("./byot/types.js").BedrockAuth): Promise<DriftScore> {
```
```ts
    const embeddings = await embedAny(turnSummary, this.embeddingModel, auth);
```

(Leave the rest of `evaluate` unchanged.)

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep "drift-detector" || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Commit**

```bash
git add src/drift-detector.ts
git commit -m "feat(byot): DriftDetector threads auth to embedAny"
```

---

## Task 12: `IntentJudge.evaluate` — thread `auth` + propagate `byotFallback`

**Files:**
- Modify: `src/intent-judge.ts` (`JudgeVerdict` interface ~line 89, `evaluate` signature ~line 553, the bedrock branch ~line 587)

- [ ] **Step 1: Add `byotFallback?` to `JudgeVerdict`**

In the `JudgeVerdict` interface (~line 89), add:

```ts
  /** Set when the judge's Bedrock call fell back from a BYOT bearer
   *  token to the platform role. Surfaced up to the handler so the
   *  dashboard can warn the user their token failed. */
  byotFallback?: { reason: string };
```

- [ ] **Step 2: Add `auth?` as the final param of `evaluate`**

Change the signature (after `priorApprovals?: JudgePriorApproval[],`):

```ts
    priorApprovals?: JudgePriorApproval[],
    auth?: import("./byot/types.js").BedrockAuth,
  ): Promise<JudgeVerdict> {
```

- [ ] **Step 3: Pass `auth` to `bedrockChat` and capture fallback**

Change the bedrock branch call (~line 587) from:

```ts
        const response = await bedrockChat(systemPrompt, finalUserPrompt, this.chatModel, this.effort, bedrockImages, "judge");
```
to:
```ts
        const response = await bedrockChat(systemPrompt, finalUserPrompt, this.chatModel, this.effort, bedrockImages, "judge", auth);
```

Then, where the bedrock branch assigns response fields (right after `cacheWriteInputTokens = response.cacheWriteInputTokens;`), add:

```ts
        var judgeByotFallback = response.byotFallback; // hoisted; read at return
```

> Implementation note: `intent-judge.ts` builds its verdict object near the
> end of `evaluate`. Add `byotFallback: judgeByotFallback` to each `return {
> verdict, ... }` that follows a successful bedrock call. The simplest
> robust approach: declare `let byotFallback: { reason: string } | undefined;`
> at the top of `evaluate`, assign it in the bedrock branch
> (`byotFallback = response.byotFallback;`), and spread `...(byotFallback ? { byotFallback } : {})`
> into the final verdict object that `evaluate` returns. Use that pattern
> instead of the `var` above.

- [ ] **Step 4: Apply the clean pattern**

At the top of `evaluate` (after the param list), add:

```ts
    let byotFallback: { reason: string } | undefined;
```

In the bedrock branch (after the response field assignments), add:

```ts
        byotFallback = response.byotFallback;
```

At the `evaluate` function's main success `return { verdict, confidence, reasoning, ... }` (the one reached after parsing the model response — the JSON-parse path around line 609/698), add to the object:

```ts
        ...(byotFallback ? { byotFallback } : {}),
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep "intent-judge" || echo "clean"`
Expected: `clean`

- [ ] **Step 6: Commit**

```bash
git add src/intent-judge.ts
git commit -m "feat(byot): IntentJudge threads auth + propagates byotFallback"
```

---

## Task 13: `PreToolInterceptor.evaluate` — `bedrockAuth` param + thread + surface fallback

**Files:**
- Modify: `src/pretool-interceptor.ts` (`InterceptionResult` ~line 81–140, `evaluate` signature ~line 281–333, judge call ~line 704, drift call ~line 587, pattern-trust embed ~line 398)

- [ ] **Step 1: Add `byotFallback?` to `InterceptionResult`**

In the `InterceptionResult` interface (~line 81), add:

```ts
  /** Set when a BYOT bearer call fell back to the platform role during
   *  this evaluation (judge path). Drives the dashboard fallback banner. */
  byotFallback?: { reason: string };
```

- [ ] **Step 2: Add `bedrockAuth?` as the final param of `evaluate`**

After `patternTrustHard?: boolean,` (~line 332):

```ts
    patternTrustHard?: boolean,
    /** Resolved Bedrock credential for this session's owner. Threaded to
     *  the judge + drift + pattern-trust embed so the user's token (when
     *  configured) bills their account. Undefined / {kind:"default"} =
     *  platform role. */
    bedrockAuth?: import("./byot/types.js").BedrockAuth,
  ): Promise<InterceptionResult> {
```

- [ ] **Step 3: Thread `bedrockAuth` into the three Bedrock call sites**

Pattern-trust embed (~line 398):
```ts
          const callVecs = await embedAny(callText, this.config.embeddingModel, bedrockAuth);
```

Drift evaluate (~line 587):
```ts
    const drift = await s.driftDetector.evaluate(toolDescription, bedrockAuth);
```

Judge evaluate (~line 704) — append `bedrockAuth` as the final arg (after the `priorApprovals` arg the call already passes):
```ts
    const judgeVerdict = await this.judge.evaluate(
      /* …existing args… */,
      bedrockAuth,
    );
```
> Locate the existing `this.judge.evaluate(...)` call and add `bedrockAuth`
> as the final positional argument, matching the new `auth?` param order
> from Task 12.

- [ ] **Step 4: Surface judge fallback on the result**

Where the interceptor builds its returned `InterceptionResult` from the judge verdict (the judge-path return), add:

```ts
      ...(judgeVerdict.byotFallback ? { byotFallback: judgeVerdict.byotFallback } : {}),
```

> Note: `registerGoal` (Task 11) also takes `auth`, but it runs at
> `/intent` time, not in `evaluate`. It's wired in the next task's handler
> if/when the registration path needs the user's token; the drift
> baseline at `evaluate` time uses `setGoalEmbeddings` with pre-computed
> vectors, so the judge + pattern-trust + drift-evaluate paths above are
> the ones that bill per call.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep "pretool-interceptor" || echo "clean"`
Expected: `clean`

- [ ] **Step 6: Commit**

```bash
git add src/pretool-interceptor.ts
git commit -m "feat(byot): interceptor threads bedrockAuth + surfaces judge fallback"
```

---

## Task 14: Wire stores + provider in `server-core`; resolve + record in `/evaluate`

**Files:**
- Modify: `src/server-core.ts` (after the BYOT env vars from Task 1; near the other store constructions ~line 620)
- Modify: `src/handlers/evaluate.ts` (resolve auth ~before line 389; record fallback ~after line 402)

- [ ] **Step 1: Construct the store, crypto, and provider in `server-core.ts`**

After the user-permissions store block (~line 630), add:

```ts
// ---------------------------------------------------------------------------
// BYOT store + crypto + credential provider. The provider is the DEFAULT
// (platform-only) no-op unless DREDD_BYOT_ENABLED is set, so flipping the
// flag is the single switch that turns on hot-path resolution.
// ---------------------------------------------------------------------------
import { InMemoryByotStore } from "./byot-store.js";
import { DynamoByotStore } from "./dynamo-byot-store.js";
import { KmsByotCrypto, FakeByotCrypto } from "./byot/byot-crypto.js";
import {
  DefaultCredentialProvider,
  BearerCredentialProvider,
  type CredentialProvider,
} from "./byot/credential-provider.js";
import type { ByotStore } from "./byot-store.js";
import type { ByotCrypto } from "./byot/byot-crypto.js";

export const byotStore: ByotStore = STORE_BACKEND === "dynamo"
  ? new DynamoByotStore({ tableName: DYNAMO_BYOT_TABLE_NAME, region: DYNAMO_REGION })
  : new InMemoryByotStore();

export const byotCrypto: ByotCrypto = BYOT_KMS_KEY_ID
  ? new KmsByotCrypto({ keyId: BYOT_KMS_KEY_ID, region: DYNAMO_REGION })
  : new FakeByotCrypto();

export const credentialProvider: CredentialProvider = BYOT_ENABLED
  ? new BearerCredentialProvider({ store: byotStore, crypto: byotCrypto })
  : new DefaultCredentialProvider();

console.log(
  `  [BYOT]  ${BYOT_ENABLED ? "ENABLED" : "disabled"} ` +
    `(store=${STORE_BACKEND}, table=${DYNAMO_BYOT_TABLE_NAME}, ` +
    `kms=${BYOT_KMS_KEY_ID ? "configured" : "FAKE (dev)"})`,
);
```

> Move the `import` lines to the top of `server-core.ts` with the other
> imports if the file's lint config disallows mid-file imports; the
> codebase already groups imports at the top, so place them there and keep
> only the `export const` lines here.

- [ ] **Step 2: Resolve `bedrockAuth` in the `/evaluate` handler**

In `src/handlers/evaluate.ts`, import the provider and the store at the top (with the other `server-core` imports):

```ts
import { credentialProvider, byotStore } from "../server-core.js";
```

Just before the `const result = await interceptor.evaluate(` call (~line 389), add:

```ts
  // Resolve the session owner's BYOT credential (cached; {kind:"default"}
  // when BYOT is off or the user has no token configured).
  const bedrockAuth = await credentialProvider.resolve(ownerForApproval.ownerSub);
```

Add `bedrockAuth` as the final argument to the `interceptor.evaluate(...)` call (after `PATTERN_LEARNING_HARD,`):

```ts
    PATTERN_LEARNING_HARD,
    bedrockAuth,
  );
```

- [ ] **Step 3: Record a runtime fallback on the BYOT record (throttled)**

After the `interceptor.evaluate(...)` call returns (~after line 402, before/after `recordToolCall`), add:

```ts
  // Spec §7: surface BYOT runtime failures on the config record so the
  // dashboard can warn the user. Throttled in-memory to once / 5 min per
  // owner to avoid hammering Dynamo when a token stays broken.
  if (result.byotFallback && ownerForApproval.ownerSub) {
    void recordByotFallbackThrottled(ownerForApproval.ownerSub, result.byotFallback.reason);
  }
```

At module scope in `evaluate.ts` (top-level, after imports), add the throttle helper:

```ts
const BYOT_FALLBACK_THROTTLE_MS = 5 * 60 * 1000;
const lastByotFallbackAt = new Map<string, number>();
async function recordByotFallbackThrottled(ownerSub: string, reason: string): Promise<void> {
  const now = Date.now();
  const last = lastByotFallbackAt.get(ownerSub) ?? 0;
  if (now - last < BYOT_FALLBACK_THROTTLE_MS) return;
  lastByotFallbackAt.set(ownerSub, now);
  try {
    await byotStore.markRuntimeFallback(ownerSub, reason, new Date().toISOString());
  } catch (err) {
    console.warn(`[byot] markRuntimeFallback failed for ${ownerSub.substring(0, 8)}: ${(err as Error)?.message ?? err}`);
  }
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E "server-core|handlers/evaluate" || echo "clean"`
Expected: `clean`

- [ ] **Step 5: Smoke-test the existing pipeline test still passes (no BYOT configured → default path)**

Run: `npx tsx hooks/tests/test_phase4_pipeline.ts`
Expected: same pass count as before this plan (BYOT defaults to `{kind:"default"}`, behaviour unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/server-core.ts src/handlers/evaluate.ts
git commit -m "feat(byot): wire provider/store in server-core; resolve+record in /evaluate"
```

---

## Task 15: Capability probe

**Files:**
- Create: `src/byot/capability-probe.ts`
- Test: `hooks/tests/test_byot_probe.ts`

- [ ] **Step 1: Write the failing test (mock bedrock-client by intercepting via a stubbed module is heavy; instead test the failure-aggregation logic with injected probe functions)**

```ts
// hooks/tests/test_byot_probe.ts
// Run: npx tsx hooks/tests/test_byot_probe.ts
import { aggregateProbe } from "../../src/byot/capability-probe.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const allOk = await aggregateProbe([
    { model: "judge", api: "Converse", run: async () => {} },
    { model: "embed", api: "InvokeModel", run: async () => {} },
  ]);
  ok("all pass → ok:true, no failures", allOk.ok && allOk.failures.length === 0);

  const oneBad = await aggregateProbe([
    { model: "judge", api: "Converse", run: async () => {} },
    { model: "embed", api: "InvokeModel", run: async () => { const e: any = new Error("no"); e.name = "AccessDeniedException"; throw e; } },
  ]);
  ok("one fails → ok:false", !oneBad.ok);
  ok("failure names the model + error", oneBad.failures.length === 1 && oneBad.failures[0].model === "embed" && oneBad.failures[0].error === "AccessDeniedException");

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx hooks/tests/test_byot_probe.ts`
Expected: FAIL — cannot find module `capability-probe.js`.

- [ ] **Step 3: Implement `capability-probe.ts`**

```ts
// src/byot/capability-probe.ts
import { bedrockChat, bedrockEmbed } from "../bedrock-client.js";
import type { BedrockAuth } from "./types.js";

export interface ProbeFailure { model: string; api: string; error: string; }
export interface ProbeResult { ok: boolean; failures: ProbeFailure[]; }

interface ProbeStep { model: string; api: string; run: () => Promise<void>; }

/** Run each probe step, collecting failures. Exported for unit testing the
 *  aggregation independently of Bedrock. */
export async function aggregateProbe(steps: ProbeStep[]): Promise<ProbeResult> {
  const failures: ProbeFailure[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failures.push({ model: step.model, api: step.api, error: (err as { name?: string })?.name ?? (err as Error)?.message ?? "error" });
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Confirm a token+region can serve every distinct model the per-session
 * pipeline uses. Enumerated from config so adding a model extends the
 * probe automatically. `noFallback` is set so a broken token surfaces
 * here instead of being masked by bedrock-client's fail-soft.
 */
export async function probeRegionCapabilities(
  token: string,
  region: string,
  models: { judgeModel: string; embeddingModel: string; extraModels?: { model: string; api: "Converse" }[] },
): Promise<ProbeResult> {
  const auth: BedrockAuth = { kind: "bearer", token, region, noFallback: true };
  const steps: ProbeStep[] = [
    {
      model: models.judgeModel, api: "Converse",
      run: async () => { await bedrockChat("You are a test.", "Reply with the single word: ok", models.judgeModel, undefined, undefined, "preflight", auth); },
    },
    {
      model: models.embeddingModel, api: "InvokeModel",
      run: async () => { await bedrockEmbed(["ok"], models.embeddingModel, region, auth); },
    },
    ...(models.extraModels ?? []).map((m) => ({
      model: m.model, api: m.api,
      run: async () => { await bedrockChat("You are a test.", "Reply with the single word: ok", m.model, undefined, undefined, "preflight", auth); },
    })),
  ];
  // Dedupe by (model, api) so an equal judge/classifier ID isn't probed twice.
  const seen = new Set<string>();
  const deduped = steps.filter((s) => { const k = `${s.model}#${s.api}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return aggregateProbe(deduped);
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx tsx hooks/tests/test_byot_probe.ts`
Expected: `ALL PASS (3/3)`

- [ ] **Step 5: Commit**

```bash
git add src/byot/capability-probe.ts hooks/tests/test_byot_probe.ts
git commit -m "feat(byot): capability probe (every distinct model, no-fallback)"
```

---

## Task 16: `ByotService` + dashboard `POST/GET/DELETE /api/byot`

**Files:**
- Create: `src/byot/byot-service.ts`
- Modify: `src/server-dashboard.ts` (new endpoint block after the `/api/keys` block ~line 419)
- Modify: `src/server-core.ts` (export a `byotService` constructed from store+crypto)

- [ ] **Step 1: Implement `byot-service.ts`**

```ts
// src/byot/byot-service.ts
import type { ByotStore } from "../byot-store.js";
import type { ByotCrypto } from "./byot-crypto.js";
import type { ByotConfigRecord, ByotConfigStatusView } from "./types.js";
import { probeRegionCapabilities, type ProbeResult } from "./capability-probe.js";

export interface ByotServiceOptions {
  store: ByotStore;
  crypto: ByotCrypto;
  models: { judgeModel: string; embeddingModel: string };
  /** Invalidate the hot-path provider cache on write/delete (optional —
   *  the dashboard container and hook container are separate processes,
   *  so this only matters in a single-process/dev deployment). */
  onChange?: (ownerSub: string) => void;
}

export class ByotService {
  constructor(private readonly opts: ByotServiceOptions) {}

  async getStatus(ownerSub: string): Promise<ByotConfigStatusView> {
    const r = await this.opts.store.get(ownerSub);
    if (!r) return { configured: false };
    return {
      configured: true,
      provider: r.provider,
      region: r.region,
      last4: r.last4,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastValidatedAt: r.lastValidatedAt,
      lastFallbackAt: r.lastFallbackAt ?? null,
      lastFallbackReason: r.lastFallbackReason ?? null,
    };
  }

  /** Validate the token against every model in the chosen region, then
   *  encrypt + store. Returns the probe result; on failure nothing is
   *  stored. */
  async validateAndStore(
    ownerSub: string,
    token: string,
    region: string,
  ): Promise<{ stored: boolean; probe: ProbeResult }> {
    const probe = await probeRegionCapabilities(token, region, this.opts.models);
    if (!probe.ok) return { stored: false, probe };

    const now = new Date().toISOString();
    const existing = await this.opts.store.get(ownerSub);
    const ciphertext = await this.opts.crypto.encrypt(token, { ownerSub });
    const record: ByotConfigRecord = {
      ownerSub,
      provider: "bedrock-bearer",
      region,
      ciphertext,
      last4: token.slice(-4),
      status: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastValidatedAt: now,
      lastFallbackAt: null,
      lastFallbackReason: null,
    };
    await this.opts.store.put(record);
    this.opts.onChange?.(ownerSub);
    return { stored: true, probe };
  }

  async remove(ownerSub: string): Promise<void> {
    await this.opts.store.delete(ownerSub);
    this.opts.onChange?.(ownerSub);
  }
}
```

- [ ] **Step 2: Construct `byotService` in `server-core.ts`**

After the provider construction (Task 14 Step 1), add:

```ts
import { ByotService } from "./byot/byot-service.js";

export const byotService = new ByotService({
  store: byotStore,
  crypto: byotCrypto,
  models: { judgeModel: CONFIG.judgeModel, embeddingModel: CONFIG.embeddingModel },
  onChange: (ownerSub) => {
    // Single-process dev: keep the provider cache coherent. In prod the
    // dashboard + hook are separate processes; the hook's 5-min cache TTL
    // bounds staleness there.
    if (credentialProvider instanceof BearerCredentialProvider) {
      credentialProvider.invalidate(ownerSub);
    }
  },
});
```

- [ ] **Step 3: Add the endpoints to `server-dashboard.ts`**

After the `/api/keys` DELETE block (~line 440), add. First add `byotService` to the `server-core` import at the top of `server-dashboard.ts`:

```ts
import { byotService } from "./server-core.js";
```

Then the endpoint block:

```ts
    // ---------------------------------------------------------------
    // BYOT — per-user Bedrock token. GET status (never the token),
    // POST validate-then-store, DELETE remove. ownerSub = Clerk userId.
    // ---------------------------------------------------------------
    if (url.pathname === "/api/byot") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;

      if (req.method === "GET") {
        return json(res, 200, await byotService.getStatus(principal.userId));
      }

      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const token = String(body.token ?? "").trim();
        const region = String(body.region ?? "").trim();
        if (!token) return json(res, 400, { error: "token is required" });
        if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) {
          return json(res, 400, { error: "valid AWS region is required (e.g. eu-west-2)" });
        }
        let result;
        try {
          result = await byotService.validateAndStore(principal.userId, token, region);
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
        return json(res, 200, await byotService.getStatus(principal.userId));
      }

      if (req.method === "DELETE") {
        await byotService.remove(principal.userId);
        return json(res, 200, { configured: false });
      }

      return json(res, 405, { error: "Method not allowed" });
    }
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E "byot-service|server-dashboard|server-core" || echo "clean"`
Expected: `clean`

- [ ] **Step 5: Commit**

```bash
git add src/byot/byot-service.ts src/server-core.ts src/server-dashboard.ts
git commit -m "feat(byot): ByotService + dashboard /api/byot (validate-then-store)"
```

---

## Task 17: Dashboard UI — BYOT section + fallback banner

**Files:**
- Modify: `src/web/dashboard.html`

- [ ] **Step 1: Find the API Keys tab markup + its tab-switching pattern**

Run: `grep -n "api/keys\|API Keys\|data-tab\|tab-keys\|renderKeys\|fetch(" src/web/dashboard.html | head -30`
Expected: locate the API Keys tab `<section>` / button and the `fetch('/api/keys'...)` render function. Mirror that structure for BYOT.

- [ ] **Step 2: Add the BYOT tab button + section**

Add a tab button next to the API Keys tab button (match the existing class names found in Step 1):

```html
<button class="tab-btn" data-tab="byot">BYOT</button>
```

Add the section (place after the API Keys `<section>`; match existing section class names):

```html
<section id="tab-byot" class="tab-panel" hidden>
  <h2>Bring Your Own Token (Bedrock)</h2>
  <p class="muted">Supply your own Amazon Bedrock API key. When configured, the
     judge, classifier, and embedding calls for your sessions run on your AWS
     account. The token is validated against your region and stored encrypted —
     it is never shown again.</p>

  <div id="byot-status"></div>

  <form id="byot-form">
    <label>Bedrock API key
      <input type="password" id="byot-token" autocomplete="off" placeholder="paste your Bedrock bearer token" required />
    </label>
    <label>Region
      <select id="byot-region">
        <option value="eu-west-2">eu-west-2</option>
        <option value="eu-west-1">eu-west-1</option>
        <option value="eu-central-1">eu-central-1</option>
        <option value="us-east-1">us-east-1</option>
        <option value="us-west-2">us-west-2</option>
      </select>
    </label>
    <button type="submit" id="byot-save">Validate &amp; save</button>
    <span id="byot-msg" class="muted"></span>
  </form>
</section>
```

- [ ] **Step 3: Add the render + submit JS**

Add near the other tab render functions (match the existing `fetch` + auth-header helper — find how other calls attach the Clerk bearer; reuse that helper, referred to below as `authedFetch`):

```html
<script>
async function renderByot() {
  const statusEl = document.getElementById('byot-status');
  const msgEl = document.getElementById('byot-msg');
  msgEl.textContent = '';
  try {
    const r = await authedFetch('/api/byot');
    const s = await r.json();
    if (!s.configured) {
      statusEl.innerHTML = '<p class="muted">No token configured — all Bedrock calls use the platform account.</p>';
      return;
    }
    const fallbackWarn = (s.status === 'runtime-fallback')
      ? `<div class="warn">⚠ Your token recently failed (${s.lastFallbackReason || 'error'} at ${s.lastFallbackAt || '?'}). Calls fell back to the platform. Re-validate or replace it.</div>`
      : '';
    statusEl.innerHTML = `
      ${fallbackWarn}
      <table class="kv">
        <tr><td>Provider</td><td>${s.provider}</td></tr>
        <tr><td>Region</td><td>${s.region}</td></tr>
        <tr><td>Token</td><td>••••${s.last4 || ''}</td></tr>
        <tr><td>Status</td><td>${s.status}</td></tr>
        <tr><td>Last validated</td><td>${s.lastValidatedAt || '—'}</td></tr>
      </table>
      <button id="byot-remove">Remove token</button>`;
    document.getElementById('byot-remove').onclick = async () => {
      if (!confirm('Remove your Bedrock token? Sessions revert to the platform account.')) return;
      await authedFetch('/api/byot', { method: 'DELETE' });
      renderByot();
    };
  } catch (e) {
    statusEl.innerHTML = '<p class="warn">Failed to load BYOT status.</p>';
  }
}

document.getElementById('byot-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const token = document.getElementById('byot-token').value.trim();
  const region = document.getElementById('byot-region').value;
  const msgEl = document.getElementById('byot-msg');
  const btn = document.getElementById('byot-save');
  btn.disabled = true; msgEl.textContent = 'Validating against your region…';
  try {
    const r = await authedFetch('/api/byot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, region }),
    });
    const data = await r.json();
    if (!r.ok) {
      const detail = (data.failures || []).map(f => `${f.model} (${f.api}): ${f.error}`).join('; ');
      msgEl.innerHTML = `<span class="warn">${data.error || 'Failed'}${detail ? ' — ' + detail : ''}</span>`;
    } else {
      document.getElementById('byot-token').value = '';
      msgEl.textContent = 'Saved.';
      renderByot();
    }
  } catch (e) {
    msgEl.innerHTML = '<span class="warn">Request failed.</span>';
  } finally {
    btn.disabled = false;
  }
});
</script>
```

> Replace `authedFetch` with the actual helper name the dashboard already
> uses to attach the Clerk session token (found in Step 1). Also wire
> `renderByot()` into the tab-switch handler so it runs when the BYOT tab
> is shown — mirror how the API Keys tab calls its render function.

- [ ] **Step 4: Manual verification (local dev)**

Run:
```bash
STORE_BACKEND=memory DREDD_ROLE=dashboard npm run server
```
Then load the dashboard, open the BYOT tab. Expected (without Clerk configured locally the `/api/*` calls 503 — verify the tab renders and the form is present; full happy-path is covered by the endpoint test in Task 16's service). Document the rendered state.

- [ ] **Step 5: Commit**

```bash
git add src/web/dashboard.html
git commit -m "feat(byot): dashboard BYOT tab (store + status + fallback banner)"
```

---

## Task 18: Terraform — `jaid-byot` table + IAM + env

**Files:**
- Create: `terraform/jaid-byot.tf`
- Modify: `terraform/iam.tf` (dashboard + hook task role policies)
- Modify: `terraform/ecs-hook.tf` + `terraform/ecs-dashboard.tf` (env vars) — or `terraform/variables.tf` if env is centralised there

- [ ] **Step 1: Inspect the existing table + IAM patterns to mirror exactly**

Run:
```bash
cat terraform/jaid-user-permissions.tf
grep -n "kms\|Encrypt\|Decrypt\|dynamodb:\|aws_iam_policy\|task_role\|jaid-user-permissions\|environment\|DYNAMO_USER_PERMISSIONS" terraform/iam.tf terraform/ecs-hook.tf terraform/ecs-dashboard.tf
```
Expected: the table HCL shape (billing mode, pk/sk attrs, SSE block, tags) and where the per-role IAM statements + container `environment` blocks live.

- [ ] **Step 2: Create `terraform/jaid-byot.tf`** (mirror `jaid-user-permissions.tf`, no TTL)

```hcl
# Per-user BYOT (bring-your-own-token) Bedrock credentials. One item per
# Clerk user (pk = USER#<ownerSub>, sk = BYOT). The token is stored
# KMS-encrypted at the application layer (see src/byot/byot-crypto.ts);
# table SSE adds at-rest encryption on top. No TTL — config persists until
# the user removes it.
resource "aws_dynamodb_table" "jaid_byot" {
  name         = "jaid-byot"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.sse_kms_key_arn
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}
```

> Match `var.tags` / SSE attribute names to whatever `jaid-user-permissions.tf`
> actually uses (Step 1 output). If that file uses `var.sse_kms_key_arn` for
> SSE, reuse it verbatim.

- [ ] **Step 3: Add IAM statements**

In `terraform/iam.tf`, add to the **dashboard** task role policy (the validate-then-store path):

```hcl
# BYOT: dashboard writes the encrypted token + reads status.
statement {
  sid    = "ByotDashboardTable"
  effect = "Allow"
  actions = [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:DeleteItem",
  ]
  resources = [aws_dynamodb_table.jaid_byot.arn]
}
statement {
  sid       = "ByotDashboardKms"
  effect    = "Allow"
  actions   = ["kms:Encrypt", "kms:DescribeKey"]
  resources = [var.sse_kms_key_arn]
}
```

Add to the **hook** task role policy (resolve + record fallback):

```hcl
# BYOT: hook reads + decrypts the token, and stamps runtime fallbacks.
statement {
  sid    = "ByotHookTable"
  effect = "Allow"
  actions = [
    "dynamodb:GetItem",
    "dynamodb:UpdateItem",
  ]
  resources = [aws_dynamodb_table.jaid_byot.arn]
}
statement {
  sid       = "ByotHookKms"
  effect    = "Allow"
  actions   = ["kms:Decrypt"]
  resources = [var.sse_kms_key_arn]
}
```

> Use the actual statement style in `iam.tf` (it may use inline JSON
> `aws_iam_role_policy` rather than `aws_iam_policy_document` data sources —
> match whichever is there from Step 1).

- [ ] **Step 4: Add env vars to both task definitions**

In the **hook** container `environment` (in `ecs-hook.tf`):

```hcl
{ name = "DYNAMO_BYOT_TABLE_NAME", value = "jaid-byot" },
{ name = "DREDD_BYOT_ENABLED",     value = var.byot_enabled },
{ name = "BYOT_KMS_KEY_ID",        value = var.sse_kms_key_arn },
```

In the **dashboard** container `environment` (in `ecs-dashboard.tf`):

```hcl
{ name = "DYNAMO_BYOT_TABLE_NAME", value = "jaid-byot" },
{ name = "BYOT_KMS_KEY_ID",        value = var.sse_kms_key_arn },
```

(Dashboard does not need `DREDD_BYOT_ENABLED` — it never resolves on the hot path; the store/service work regardless.)

Add the variable in `terraform/variables.tf`:

```hcl
variable "byot_enabled" {
  description = "Hot-path BYOT resolution toggle (DREDD_BYOT_ENABLED). Keep false until the write path has soaked."
  type        = string
  default     = "false"
}
```

- [ ] **Step 5: Validate the terraform**

Run: `cd terraform && tofu validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 6: Commit**

```bash
git add terraform/jaid-byot.tf terraform/iam.tf terraform/ecs-hook.tf terraform/ecs-dashboard.tf terraform/variables.tf
git commit -m "feat(byot): jaid-byot table + dashboard/hook IAM + env vars"
```

---

## Task 19: End-to-end pipeline test (BYOT threading)

**Files:**
- Test: `hooks/tests/test_byot_pipeline.ts`

- [ ] **Step 1: Write the test (configured BYOT resolves to bearer; flag-off resolves to default)**

```ts
// hooks/tests/test_byot_pipeline.ts
// Run: npx tsx hooks/tests/test_byot_pipeline.ts
// Verifies the credential provider + service round-trip end to end without
// hitting Bedrock: a stored+encrypted token resolves back to a bearer auth,
// and a missing one resolves to default.
import { InMemoryByotStore } from "../../src/byot-store.js";
import { FakeByotCrypto } from "../../src/byot/byot-crypto.js";
import { BearerCredentialProvider, DefaultCredentialProvider } from "../../src/byot/credential-provider.js";
import { ByotService } from "../../src/byot/byot-service.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const store = new InMemoryByotStore();
  const crypto = new FakeByotCrypto();
  const provider = new BearerCredentialProvider({ store, crypto });

  // Store a record directly (bypassing the probe, which would call Bedrock).
  const token = "byot-secret-9999";
  await store.put({
    ownerSub: "u1", provider: "bedrock-bearer", region: "eu-west-2",
    ciphertext: await crypto.encrypt(token, { ownerSub: "u1" }),
    last4: "9999", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
  });

  const auth = await provider.resolve("u1");
  ok("configured user resolves to bearer with token+region",
    auth.kind === "bearer" && auth.token === token && auth.region === "eu-west-2");

  const none = await provider.resolve("u2");
  ok("unconfigured user resolves to default", none.kind === "default");

  // Flag-off provider always returns default even when a row exists.
  const off = new DefaultCredentialProvider();
  ok("flag-off provider ignores stored config", (await off.resolve("u1")).kind === "default");

  // Service status view never leaks the token.
  const svc = new ByotService({ store, crypto, models: { judgeModel: "j", embeddingModel: "e" } });
  const view = await svc.getStatus("u1");
  ok("status view exposes last4, not the token", view.configured === true && view.last4 === "9999" && !(view as any).token && !(view as any).ciphertext);

  // Runtime fallback marker flows to the status view.
  await store.markRuntimeFallback("u1", "AccessDeniedException", "t5");
  const view2 = await svc.getStatus("u1");
  ok("status view reflects runtime fallback", view2.status === "runtime-fallback" && view2.lastFallbackReason === "AccessDeniedException");

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run the test**

Run: `npx tsx hooks/tests/test_byot_pipeline.ts`
Expected: `ALL PASS (6/6)`

- [ ] **Step 3: Run the full new BYOT suite + the pre-existing pipeline suite**

Run:
```bash
for t in crypto store provider client probe pipeline; do echo "== $t =="; npx tsx hooks/tests/test_byot_$t.ts || exit 1; done
npx tsx hooks/tests/test_phase4_pipeline.ts
```
Expected: every suite ends in `ALL PASS` / its prior pass count.

- [ ] **Step 4: Commit**

```bash
git add hooks/tests/test_byot_pipeline.ts
git commit -m "test(byot): end-to-end provider + service round-trip"
```

---

## Task 20: Docs — update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (env var table; key files table; a short BYOT section)

- [ ] **Step 1: Add the new env vars to the env var table**

Add rows for `DYNAMO_BYOT_TABLE_NAME` (default `jaid-byot`), `DREDD_BYOT_ENABLED` (default `false` — hot-path resolver gate), `BYOT_KMS_KEY_ID` (default = `sse_kms_key_arn`; KMS key for token encryption).

- [ ] **Step 2: Add a "BYOT — per-user Bedrock token" subsection**

Document: the `jaid-byot` table + item shape, the `CredentialProvider` seam (bearer now, assume-role later), that scope = all per-session Bedrock calls with fail-soft to platform creds, the dashboard validate-then-store capability probe, and that `DREDD_BYOT_ENABLED` gates only the hot path.

- [ ] **Step 3: Add the new files to the Key files table**

`src/byot/credential-provider.ts`, `src/byot/byot-crypto.ts`, `src/byot/capability-probe.ts`, `src/byot/byot-service.ts`, `src/byot-store.ts`, `src/dynamo-byot-store.ts`, `terraform/jaid-byot.tf`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(byot): CLAUDE.md env vars, files, and BYOT section"
```

---

## Deployment (after merge — not part of task-by-task TDD)

BYOT spans the hook **and** dashboard images, plus terraform. Order:

1. `cd terraform && tofu apply` — creates `jaid-byot` + IAM + env. (ECS services `ignore_changes` on task_definition, so env changes need the deploy below to take effect.)
2. Build + push **both** images (hook + dashboard) per CLAUDE.md "Building the zips" / Docker sections, then `aws ecs update-service --force-new-deployment` for each service.
3. Leave `DREDD_BYOT_ENABLED=false`. Verify a user can store a token (dashboard BYOT tab) and `GET /api/byot` shows `status:"active"` — write path soaks with the hot path still dark.
4. Flip `byot_enabled=true` (terraform var) → apply → redeploy the hook. Confirm a configured user's `/evaluate` judge calls bill their account (and that `byotFallback` surfaces if their token is wrong).

---

## Self-Review

**Spec coverage:**
- §1 provider abstraction → Tasks 2, 6 ✓ (bearer + default; assume-role seam in `BedrockAuth`)
- §2 storage (table, stores, cache, KMS, encryption context) → Tasks 3, 4, 5, 6 ✓
- §3 bedrock-client (auth params, client cache, fail-soft) → Tasks 7, 8, 9 ✓
- §4 threading → Tasks 10, 11, 12, 13 ✓
- §5 resolution point → Task 14 ✓
- §6 dashboard write path + UI + capability probe (every distinct model) → Tasks 15, 16, 17 ✓
- §7 fallback telemetry → Tasks 8/12/13 (propagation) + 14 (record) + 17 (banner) ✓ (refined to record on the BYOT record — noted at top)
- §8 IAM/terraform/env → Tasks 1, 18 ✓
- §9 error handling → Task 6 (decrypt soft-fail), 8/9 (auth retry), 16 (probe reject) ✓
- §10 testing → Tasks 3,4,5,6,7,15,19 ✓
- Out-of-scope items (assume-role build, model overrides, cost dashboards, rotation) → not implemented ✓

**Placeholder scan:** No TBD/TODO in implementation steps. One inherited `// TODO` in the existing `/api/keys` GET is left untouched (not ours).

**Type consistency:**
- `BedrockAuth` (`kind: "default" | "bearer"`, bearer carries `token`, `region`, `noFallback?`) — consistent across types.ts, bedrock-client, provider, probe, interceptor, judge, drift, embedAny.
- `byotFallback: { reason: string }` — consistent: bedrockChat return → JudgeVerdict → InterceptionResult → handler.
- `ByotStore` methods (`get`/`put`/`delete`/`markRuntimeFallback`) — consistent across interface, InMemory, Dynamo, service, provider.
- `markRuntimeFallback(ownerSub, reason, at)` arg order — consistent in store impls + handler call.
- `probeRegionCapabilities(token, region, models)` + `aggregateProbe(steps)` — consistent across probe + service + test.
- `ByotConfigStatusView` fields — consistent between service `getStatus` and dashboard render.
