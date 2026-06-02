# Admin Invite Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin generate a one-time, no-auth invite link (tied to an email, optionally referencing a shared Bedrock/BYOT token) that an invited user redeems to receive a Dredd API key + a key-baked integration bundle.

**Architecture:** A new `jaid-invites` table + `InviteStore` persist single-use, TTL'd, hashed invite tokens. `invite-service.ts` orchestrates create/list/revoke/redeem across the existing api-key store, an extended BYOT store (shared/pooled tokens + a reference record variant), and the bundle builder. Invited users get a synthetic email-derived `ownerSub`; the dashboard read-path reconciles by matching both that sub and the Clerk userId. Shared-token billing is resolved on the hot path via a one-hop follow in `BearerCredentialProvider`, gated by the existing `DREDD_BYOT_ENABLED`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node stdlib `crypto`, `@aws-sdk/lib-dynamodb`, the repo's `npx tsx` test harness, OpenTofu/Terraform, vanilla dashboard HTML.

**Spec:** `docs/superpowers/specs/2026-06-02-invite-links-design.md`

---

## File Structure

**New files:**
- `src/owner-identity.ts` — `syntheticSubForEmail()` + `ownerSubsForPrincipal()` (pure).
- `src/invite-store.ts` — `InviteStore` interface, types, token mint/hash, `InMemoryInviteStore`.
- `src/dynamo-invite-store.ts` — `DynamoInviteStore` against `jaid-invites`.
- `src/invite-service.ts` — create/list/revoke/redeem orchestration.
- `terraform/jaid-invites.tf` — the table.
- `hooks/tests/test_owner_identity.ts`, `test_invite_store.ts`, `test_invite_redeem.ts`, `test_byot_shared_reference.ts`, `test_bundle_prekeyed.ts`, `test_invite_reconcile.ts`.

**Modified files:**
- `src/api-key-store.ts` — add `"invited"` to `KeyType`.
- `src/byot/types.ts` — `ByotProvider` gains `"bedrock-bearer-ref"`; `ByotConfigRecord.refId?`; new `SharedTokenRecord` / `SharedTokenView`.
- `src/byot-store.ts` — `ByotStore` gains shared-token methods; `InMemoryByotStore` implements them.
- `src/dynamo-byot-store.ts` — implement shared-token methods (`pk = SHARED#<poolId>`).
- `src/byot/byot-service.ts` — `createShared` / `listShared` / `rotateShared` / `removeShared` / `writeReference`.
- `src/byot/credential-provider.ts` — one-hop reference follow in `resolve()`.
- `src/integration-bundle.ts` — optional `apiKey` param on `buildIntegrationBundle`.
- `src/server-core.ts` — construct `inviteStore` + `inviteService`.
- `src/server-dashboard.ts` — admin `/api/invites` + `/api/shared-tokens`; public `GET /invite`, `POST /api/invite/peek`, `POST /api/invite/redeem`.
- `src/web/dashboard.html` — Invites tab + shared-tokens section; standalone redemption page.
- `terraform/iam.tf` — dashboard task-role grants on `jaid-invites`.

---

# PHASE A — Storage + admin generate

### Task A1: Synthetic owner identity

**Files:**
- Create: `src/owner-identity.ts`
- Test: `hooks/tests/test_owner_identity.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// hooks/tests/test_owner_identity.ts
// Run: npx tsx hooks/tests/test_owner_identity.ts
import { syntheticSubForEmail, ownerSubsForPrincipal } from "../../src/owner-identity.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

function main() {
  const a = syntheticSubForEmail("Alice@Example.com");
  const b = syntheticSubForEmail("alice@example.com ");
  ok("deterministic + case/space-insensitive", a === b);
  ok("prefixed", a.startsWith("invite:"));
  ok("fixed length (invite: + 32 hex)", a.length === "invite:".length + 32);
  ok("distinct emails differ", a !== syntheticSubForEmail("bob@example.com"));

  ok("principal: both subs", JSON.stringify(ownerSubsForPrincipal({ userId: "user_1", email: "alice@example.com" }))
     === JSON.stringify(["user_1", a]));
  ok("principal: empty email → userId only",
     JSON.stringify(ownerSubsForPrincipal({ userId: "user_1", email: "" })) === JSON.stringify(["user_1"]));
  ok("principal: dedupe identical",
     JSON.stringify(ownerSubsForPrincipal({ userId: a, email: "alice@example.com" })) === JSON.stringify([a]));

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_owner_identity.ts`
Expected: FAIL — `Cannot find module '../../src/owner-identity.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/owner-identity.ts
/**
 * Identity helpers for invited users.
 *
 * An invited user redeems a no-auth link before they have any Clerk
 * account, so we derive a stable, deterministic `ownerSub` from their
 * email. The dashboard later reconciles by matching BOTH a signed-in
 * principal's Clerk userId AND this email-derived sub — no row is ever
 * rewritten (see the spec, "reconciliation").
 */
import { createHash } from "node:crypto";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `invite:` + first 32 hex chars of sha256(normalized email). No PII in
 *  the sub; deterministic so reconciliation needs no lookup table. */
export function syntheticSubForEmail(email: string): string {
  const hex = createHash("sha256").update(normalizeEmail(email), "utf8").digest("hex");
  return "invite:" + hex.slice(0, 32);
}

/** The set of owner subs a signed-in principal should be matched against:
 *  their Clerk userId plus the email-derived sub (so invited history shows
 *  up after they sign in). Deduped; email-sub omitted when email is empty. */
export function ownerSubsForPrincipal(principal: { userId: string; email: string }): string[] {
  const subs = [principal.userId];
  if (principal.email && principal.email.trim()) subs.push(syntheticSubForEmail(principal.email));
  return [...new Set(subs)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_owner_identity.ts`
Expected: `ALL PASS (7/7)`.

- [ ] **Step 5: Commit**

```bash
git add src/owner-identity.ts hooks/tests/test_owner_identity.ts
git commit -m "feat(invite): synthetic email-derived owner identity"
```

---

### Task A2: Type additions (KeyType + BYOT shared/reference types)

**Files:**
- Modify: `src/api-key-store.ts:29`
- Modify: `src/byot/types.ts:22-48`

- [ ] **Step 1: Add the `invited` key type**

In `src/api-key-store.ts`, change line 29:

```typescript
export type KeyType = "user" | "service" | "benchmark" | "invited";
```

- [ ] **Step 2: Extend the BYOT provider + add shared-token types**

In `src/byot/types.ts`, replace the `ByotProvider` line (22) with:

```typescript
export type ByotProvider = "bedrock-bearer" | "bedrock-bearer-ref";
```

In the `ByotConfigRecord` interface (after `setByAdminAt?`), add:

```typescript
  /** When provider is "bedrock-bearer-ref": the poolId of the shared token
   *  this row points at. Resolved one hop at credential-resolve time. */
  refId?: string | null;
```

At the end of the file, add:

```typescript
/** A shared/pooled Bedrock token referenced by many invitees.
 *  Stored in jaid-byot under pk = SHARED#<poolId>, sk = TOKEN. */
export interface SharedTokenRecord {
  poolId: string;
  name: string;
  region: string;
  ciphertext: string;
  last4: string;
  status: ByotConfigStatus;
  createdAt: string;
  updatedAt: string;
}

/** Non-sensitive projection of a shared token — never the token. */
export interface SharedTokenView {
  poolId: string;
  name: string;
  region: string;
  last4: string;
  status: ByotConfigStatus;
  createdAt: string;
  updatedAt: string;
  /** Number of invites that reference this token. Augmented by the route
   *  from the invite list — the BYOT service does not depend on invites. */
  refCount?: number;
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors. (If pre-existing unrelated errors exist, confirm none reference `api-key-store.ts` or `byot/types.ts`.)

- [ ] **Step 4: Commit**

```bash
git add src/api-key-store.ts src/byot/types.ts
git commit -m "feat(invite): add invited keyType + BYOT shared/reference types"
```

---

### Task A3: InviteStore interface + InMemoryInviteStore

**Files:**
- Create: `src/invite-store.ts`
- Test: `hooks/tests/test_invite_store.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// hooks/tests/test_invite_store.ts
// Run: npx tsx hooks/tests/test_invite_store.ts
import { InMemoryInviteStore, hashToken } from "../../src/invite-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  let nowSec = 1000;
  const store = new InMemoryInviteStore(() => nowSec);

  const { record, plaintextToken } = await store.createInvite({
    email: "alice@example.com", createdBySub: "admin_1", createdByEmail: "admin@x.io",
    expiresInHours: 1, sharedTokenId: "pool_a",
  });
  ok("token is opaque, not the hash", plaintextToken !== record.tokenHash && plaintextToken.length >= 40);
  ok("hash stored, plaintext not", record.tokenHash === hashToken(plaintextToken));
  ok("status pending", record.status === "pending");
  ok("expiresAt = now + 1h", record.expiresAt === 1000 + 3600);
  ok("carries sharedTokenId", record.sharedTokenId === "pool_a");

  ok("findByToken returns record (peek, no consume)", (await store.findByToken(plaintextToken))?.email === "alice@example.com");
  ok("findByToken does NOT consume", (await store.findByToken(plaintextToken))?.status === "pending");
  ok("findByToken unknown → null", (await store.findByToken("nope")) === null);

  // consume = atomic pending→redeemed
  const won = await store.consume(plaintextToken, "2026-06-02T00:00:00Z");
  ok("consume wins once", won?.status === "redeemed" && won?.redeemedAt === "2026-06-02T00:00:00Z");
  ok("second consume loses", (await store.consume(plaintextToken, "later")) === null);

  await store.stampResult(record.tokenHash, { resultingKeyHash: "abc", resultingOwnerSub: "invite:xyz" });
  ok("stampResult records key+owner", (await store.findByToken(plaintextToken))?.resultingKeyHash === "abc");

  // expiry
  const e = await store.createInvite({ email: "b@x.io", createdBySub: "a", createdByEmail: null, expiresInHours: 1 });
  nowSec = 1000 + 3601;
  ok("expired invite cannot be consumed", (await store.consume(e.plaintextToken, "t")) === null);

  // revoke
  const r = await store.createInvite({ email: "c@x.io", createdBySub: "a", createdByEmail: null });
  ok("revoke pending succeeds", (await store.revoke(r.record.tokenHash, "admin_1")) === true);
  ok("revoked cannot be consumed", (await store.consume(r.plaintextToken, "t")) === null);

  ok("listAll returns all created", (await store.listAll()).length === 4);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_invite_store.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/invite-store.ts
/**
 * Invite store.
 *
 * One-time, TTL'd, hashed onboarding tokens. The plaintext token exists
 * only in the redemption URL (carried in the fragment); we persist only
 * its SHA-256 hash, exactly like the API-key store. `consume` is the
 * atomic single-use lock (pending → redeemed). See terraform/jaid-invites.tf.
 */
import { createHash, randomBytes } from "node:crypto";

export type InviteStatus = "pending" | "redeemed" | "revoked";

export interface InviteRecord {
  /** sha256(plaintextToken) hex, 64 chars. Primary identifier. */
  tokenHash: string;
  email: string;
  status: InviteStatus;
  createdBySub: string;
  createdByEmail: string | null;
  createdAt: string;          // ISO
  expiresAt: number;          // epoch seconds
  ttl: number;                // epoch seconds (DynamoDB TTL attribute)
  /** poolId of an allocated shared BYOT token, or null. */
  sharedTokenId: string | null;
  redeemedAt: string | null;
  resultingKeyHash: string | null;
  resultingOwnerSub: string | null;
}

export interface CreateInviteInput {
  email: string;
  createdBySub: string;
  createdByEmail: string | null;
  /** Defaults to 1 hour. */
  expiresInHours?: number;
  sharedTokenId?: string | null;
}

export interface StampResultInput {
  resultingKeyHash: string;
  resultingOwnerSub: string;
}

export interface InviteStore {
  createInvite(input: CreateInviteInput): Promise<{ record: InviteRecord; plaintextToken: string }>;
  /** Peek — look up by plaintext token without consuming. Null if unknown. */
  findByToken(plaintextToken: string): Promise<InviteRecord | null>;
  /** Atomic single-use lock: pending + unexpired → redeemed. Returns the
   *  updated record on success, null if it was already consumed/expired/revoked
   *  or unknown (the loser of a race gets null). */
  consume(plaintextToken: string, redeemedAt: string): Promise<InviteRecord | null>;
  /** Best-effort: stamp the resulting key hash + owner sub for traceability. */
  stampResult(tokenHash: string, input: StampResultInput): Promise<void>;
  listAll(limit?: number): Promise<InviteRecord[]>;
  revoke(tokenHash: string, by: string): Promise<boolean>;
}

/** 32 bytes of entropy, base64url (~43 chars, URL/fragment-safe). */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** ~7 days past expiry — redeemed/expired rows linger briefly for the admin
 *  list, then DynamoDB TTL sweeps them. */
const TTL_GRACE_SECONDS = 7 * 24 * 3600;

export class InMemoryInviteStore implements InviteStore {
  private rows = new Map<string, InviteRecord>();
  constructor(private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000)) {}

  async createInvite(input: CreateInviteInput): Promise<{ record: InviteRecord; plaintextToken: string }> {
    const plaintextToken = mintToken();
    const tokenHash = hashToken(plaintextToken);
    const now = this.nowSec();
    const expiresAt = now + Math.round((input.expiresInHours ?? 1) * 3600);
    const record: InviteRecord = {
      tokenHash,
      email: input.email,
      status: "pending",
      createdBySub: input.createdBySub,
      createdByEmail: input.createdByEmail,
      createdAt: new Date(now * 1000).toISOString(),
      expiresAt,
      ttl: expiresAt + TTL_GRACE_SECONDS,
      sharedTokenId: input.sharedTokenId ?? null,
      redeemedAt: null,
      resultingKeyHash: null,
      resultingOwnerSub: null,
    };
    this.rows.set(tokenHash, record);
    return { record, plaintextToken };
  }

  async findByToken(plaintextToken: string): Promise<InviteRecord | null> {
    return this.rows.get(hashToken(plaintextToken)) ?? null;
  }

  async consume(plaintextToken: string, redeemedAt: string): Promise<InviteRecord | null> {
    const r = this.rows.get(hashToken(plaintextToken));
    if (!r || r.status !== "pending" || r.expiresAt <= this.nowSec()) return null;
    r.status = "redeemed";
    r.redeemedAt = redeemedAt;
    return r;
  }

  async stampResult(tokenHash: string, input: StampResultInput): Promise<void> {
    const r = this.rows.get(tokenHash);
    if (!r) return;
    r.resultingKeyHash = input.resultingKeyHash;
    r.resultingOwnerSub = input.resultingOwnerSub;
  }

  async listAll(limit = 200): Promise<InviteRecord[]> {
    const all = [...this.rows.values()];
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all.slice(0, limit);
  }

  async revoke(tokenHash: string, _by: string): Promise<boolean> {
    const r = this.rows.get(tokenHash);
    if (!r || r.status !== "pending") return false;
    r.status = "revoked";
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_invite_store.ts`
Expected: `ALL PASS (16/16)`.

- [ ] **Step 5: Commit**

```bash
git add src/invite-store.ts hooks/tests/test_invite_store.ts
git commit -m "feat(invite): InviteStore + InMemoryInviteStore (single-use, TTL)"
```

---

### Task A4: DynamoInviteStore

**Files:**
- Create: `src/dynamo-invite-store.ts`
- Test: append to `hooks/tests/test_invite_store.ts`

- [ ] **Step 1: Add the failing Dynamo test (append before the final summary block)**

Insert this in `hooks/tests/test_invite_store.ts` just before the `console.log(...ALL PASS...)` line:

```typescript
  // ---- DynamoInviteStore against an in-memory fake DocumentClient ----
  const { DynamoInviteStore } = await import("../../src/dynamo-invite-store.js");
  const table = new Map<string, any>();
  let dnow = 5000;
  const fakeClient = {
    async send(cmd: any): Promise<any> {
      const n = cmd.constructor.name;
      const key = (k: any) => `${k.pk}`;
      if (n === "PutCommand") { table.set(key(cmd.input.Item), cmd.input.Item); return {}; }
      if (n === "GetCommand") { return { Item: table.get(key(cmd.input.Key)) }; }
      if (n === "QueryCommand") {
        const items = [...table.values()].filter(i => i.gsi1pk === "INVITE")
          .sort((a, b) => b.gsi1sk.localeCompare(a.gsi1sk));
        return { Items: items };
      }
      if (n === "UpdateCommand") {
        const item = table.get(key(cmd.input.Key));
        // Emulate the consume condition: status = pending AND expiresAt > :now
        const v = cmd.input.ExpressionAttributeValues ?? {};
        const isConsume = cmd.input.UpdateExpression.includes(":redeemed");
        if (isConsume) {
          if (!item || item.status !== "pending" || item.expiresAt <= v[":now"]) {
            const err: any = new Error("conditional"); err.name = "ConditionalCheckFailedException"; throw err;
          }
          item.status = "redeemed"; item.redeemedAt = v[":at"];
          return { Attributes: item };
        }
        const isRevoke = cmd.input.UpdateExpression.includes(":revoked");
        if (isRevoke) {
          if (!item || item.status !== "pending") {
            const err: any = new Error("conditional"); err.name = "ConditionalCheckFailedException"; throw err;
          }
          item.status = "revoked"; return { Attributes: item };
        }
        // stampResult
        if (item) { item.resultingKeyHash = v[":kh"]; item.resultingOwnerSub = v[":os"]; }
        return {};
      }
      throw new Error("unexpected command " + n);
    },
  } as any;
  const dyn = new DynamoInviteStore({ tableName: "jaid-invites", region: "eu-west-1", client: fakeClient, nowSec: () => dnow });
  const made = await dyn.createInvite({ email: "d@x.io", createdBySub: "admin", createdByEmail: null, expiresInHours: 1 });
  ok("dynamo create+find round-trips", (await dyn.findByToken(made.plaintextToken))?.email === "d@x.io");
  ok("dynamo listAll via GSI", (await dyn.listAll()).length === 1);
  const dwon = await dyn.consume(made.plaintextToken, "ts");
  ok("dynamo consume wins once", dwon?.status === "redeemed");
  ok("dynamo second consume loses (conditional)", (await dyn.consume(made.plaintextToken, "ts2")) === null);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_invite_store.ts`
Expected: FAIL — `Cannot find module '../../src/dynamo-invite-store.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/dynamo-invite-store.ts
/**
 * DynamoDB-backed InviteStore. One row per invite in `jaid-invites`.
 *   pk = INVITE#<tokenHash>
 *   GSI1: gsi1pk = "INVITE", gsi1sk = createdAt  (admin list, newest first)
 * `consume` and `revoke` use conditional UpdateItem so the single-use lock
 * is enforced server-side and races resolve to exactly one winner.
 * See terraform/jaid-invites.tf.
 *
 * Injection-resistance: no PartiQL; the only key derived from input is
 * sha256(token), never raw user text.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  type InviteStore,
  type InviteRecord,
  type CreateInviteInput,
  type StampResultInput,
  hashToken,
  mintToken,
} from "./invite-store.js";

export interface DynamoInviteStoreOptions {
  tableName: string;
  region: string;
  client?: DynamoDBDocumentClient;
  nowSec?: () => number;
}

const pk = (tokenHash: string) => `INVITE#${tokenHash}`;
const TTL_GRACE_SECONDS = 7 * 24 * 3600;

function itemToRecord(item: Record<string, any>): InviteRecord {
  return {
    tokenHash: item.tokenHash,
    email: item.email,
    status: item.status,
    createdBySub: item.createdBySub,
    createdByEmail: item.createdByEmail ?? null,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    ttl: item.ttl,
    sharedTokenId: item.sharedTokenId ?? null,
    redeemedAt: item.redeemedAt ?? null,
    resultingKeyHash: item.resultingKeyHash ?? null,
    resultingOwnerSub: item.resultingOwnerSub ?? null,
  };
}

export class DynamoInviteStore implements InviteStore {
  private readonly tableName: string;
  private readonly doc: DynamoDBDocumentClient;
  private readonly nowSec: () => number;

  constructor(opts: DynamoInviteStoreOptions) {
    this.tableName = opts.tableName;
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
    this.doc = opts.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }), {
        marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
      });
  }

  async createInvite(input: CreateInviteInput): Promise<{ record: InviteRecord; plaintextToken: string }> {
    const plaintextToken = mintToken();
    const tokenHash = hashToken(plaintextToken);
    const now = this.nowSec();
    const expiresAt = now + Math.round((input.expiresInHours ?? 1) * 3600);
    const record: InviteRecord = {
      tokenHash,
      email: input.email,
      status: "pending",
      createdBySub: input.createdBySub,
      createdByEmail: input.createdByEmail,
      createdAt: new Date(now * 1000).toISOString(),
      expiresAt,
      ttl: expiresAt + TTL_GRACE_SECONDS,
      sharedTokenId: input.sharedTokenId ?? null,
      redeemedAt: null,
      resultingKeyHash: null,
      resultingOwnerSub: null,
    };
    await this.doc.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: pk(tokenHash), gsi1pk: "INVITE", gsi1sk: record.createdAt, ...record },
    }));
    return { record, plaintextToken };
  }

  async findByToken(plaintextToken: string): Promise<InviteRecord | null> {
    const out = await this.doc.send(new GetCommand({
      TableName: this.tableName, Key: { pk: pk(hashToken(plaintextToken)) },
    }));
    return out.Item ? itemToRecord(out.Item) : null;
  }

  async consume(plaintextToken: string, redeemedAt: string): Promise<InviteRecord | null> {
    try {
      const out = await this.doc.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(hashToken(plaintextToken)) },
        UpdateExpression: "SET #s = :redeemed, redeemedAt = :at",
        ConditionExpression: "#s = :pending AND expiresAt > :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":redeemed": "redeemed", ":pending": "pending", ":at": redeemedAt, ":now": this.nowSec(),
        },
        ReturnValues: "ALL_NEW",
      }));
      return out.Attributes ? itemToRecord(out.Attributes) : null;
    } catch (err) {
      if ((err as any)?.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }

  async stampResult(tokenHash: string, input: StampResultInput): Promise<void> {
    await this.doc.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: pk(tokenHash) },
      UpdateExpression: "SET resultingKeyHash = :kh, resultingOwnerSub = :os",
      ExpressionAttributeValues: { ":kh": input.resultingKeyHash, ":os": input.resultingOwnerSub },
    }));
  }

  async listAll(limit = 200): Promise<InviteRecord[]> {
    const out = await this.doc.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :p",
      ExpressionAttributeValues: { ":p": "INVITE" },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (out.Items ?? []).map(itemToRecord);
  }

  async revoke(tokenHash: string, _by: string): Promise<boolean> {
    try {
      await this.doc.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: pk(tokenHash) },
        UpdateExpression: "SET #s = :revoked",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":revoked": "revoked", ":pending": "pending" },
      }));
      return true;
    } catch (err) {
      if ((err as any)?.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_invite_store.ts`
Expected: `ALL PASS (20/20)`.

- [ ] **Step 5: Commit**

```bash
git add src/dynamo-invite-store.ts hooks/tests/test_invite_store.ts
git commit -m "feat(invite): DynamoInviteStore with conditional single-use consume"
```

---

### Task A5: Shared-token storage on ByotStore

**Files:**
- Modify: `src/byot-store.ts`
- Modify: `src/dynamo-byot-store.ts`
- Test: `hooks/tests/test_byot_shared_reference.ts` (store half)

- [ ] **Step 1: Write the failing test (store half)**

```typescript
// hooks/tests/test_byot_shared_reference.ts
// Run: npx tsx hooks/tests/test_byot_shared_reference.ts
import { InMemoryByotStore } from "../../src/byot-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  const store = new InMemoryByotStore();

  await store.putShared({
    poolId: "pool_a", name: "Team token", region: "eu-west-2",
    ciphertext: "CT", last4: "abcd", status: "active", createdAt: "t0", updatedAt: "t0",
  });
  ok("getShared round-trips", (await store.getShared("pool_a"))?.ciphertext === "CT");
  ok("getShared unknown → null", (await store.getShared("nope")) === null);
  ok("listShared returns it", (await store.listShared()).some(s => s.poolId === "pool_a"));

  // a reference row lives under USER#<ownerSub>, separate from shared rows
  await store.put({
    ownerSub: "invite:abc", provider: "bedrock-bearer-ref", refId: "pool_a",
    region: "", ciphertext: "", last4: "abcd", status: "active",
    createdAt: "t0", updatedAt: "t0", lastValidatedAt: "t0",
  });
  const ref = await store.get("invite:abc");
  ok("reference row stored under ownerSub", ref?.provider === "bedrock-bearer-ref" && ref?.refId === "pool_a");
  ok("reference does not collide with shared", (await store.getShared("invite:abc")) === null);

  await store.deleteShared("pool_a");
  ok("deleteShared removes it", (await store.getShared("pool_a")) === null);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_byot_shared_reference.ts`
Expected: FAIL — `store.putShared is not a function`.

- [ ] **Step 3: Extend `src/byot-store.ts`**

Add the import of `SharedTokenRecord` to the existing type import, and extend the interface + InMemory impl:

```typescript
// src/byot-store.ts
import type { ByotConfigRecord, ByotConfigStatus, SharedTokenRecord } from "./byot/types.js";

export interface ByotStore {
  get(ownerSub: string): Promise<ByotConfigRecord | null>;
  put(record: ByotConfigRecord): Promise<void>;
  delete(ownerSub: string): Promise<void>;
  markRuntimeFallback(ownerSub: string, reason: string, at: string): Promise<void>;
  // ---- shared/pooled tokens (pk = SHARED#<poolId>) ----
  getShared(poolId: string): Promise<SharedTokenRecord | null>;
  putShared(record: SharedTokenRecord): Promise<void>;
  listShared(): Promise<SharedTokenRecord[]>;
  deleteShared(poolId: string): Promise<void>;
}

export class InMemoryByotStore implements ByotStore {
  private readonly rows = new Map<string, ByotConfigRecord>();
  private readonly shared = new Map<string, SharedTokenRecord>();

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

  async getShared(poolId: string): Promise<SharedTokenRecord | null> {
    return this.shared.get(poolId) ?? null;
  }
  async putShared(record: SharedTokenRecord): Promise<void> {
    this.shared.set(record.poolId, { ...record });
  }
  async listShared(): Promise<SharedTokenRecord[]> {
    return [...this.shared.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async deleteShared(poolId: string): Promise<void> {
    this.shared.delete(poolId);
  }
}
```

- [ ] **Step 4: Extend `src/dynamo-byot-store.ts`**

Add `ScanCommand` to the lib-dynamodb import, import `SharedTokenRecord`, add a `SHARED#` key helper + mapper, and implement the four methods on the class:

```typescript
// add to the lib-dynamodb import list:
//   ScanCommand
// add to the type import:
import type { ByotConfigRecord, SharedTokenRecord } from "./byot/types.js";

const sharedPk = (poolId: string) => `SHARED#${poolId}`;
const SHARED_SK = "TOKEN";

function itemToShared(item: Record<string, any>): SharedTokenRecord {
  return {
    poolId: item.poolId, name: item.name, region: item.region,
    ciphertext: item.ciphertext, last4: item.last4, status: item.status,
    createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}
```

Add these methods to the `DynamoByotStore` class body:

```typescript
  async getShared(poolId: string): Promise<SharedTokenRecord | null> {
    const out = await this.doc.send(new GetCommand({
      TableName: this.tableName, Key: { pk: sharedPk(poolId), sk: SHARED_SK },
    }));
    return out.Item ? itemToShared(out.Item) : null;
  }
  async putShared(record: SharedTokenRecord): Promise<void> {
    await this.doc.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: sharedPk(record.poolId), sk: SHARED_SK, ...record },
    }));
  }
  async listShared(): Promise<SharedTokenRecord[]> {
    // Admin-only, low-cardinality (a handful of org tokens) → Scan with a
    // begins_with filter is acceptable; revisit with a GSI if it ever grows.
    const out = await this.doc.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: "sk = :tok AND begins_with(pk, :pfx)",
      ExpressionAttributeValues: { ":tok": SHARED_SK, ":pfx": "SHARED#" },
    }));
    return (out.Items ?? []).map(itemToShared).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async deleteShared(poolId: string): Promise<void> {
    await this.doc.send(new DeleteCommand({
      TableName: this.tableName, Key: { pk: sharedPk(poolId), sk: SHARED_SK },
    }));
  }
```

Also update the existing `itemToRecord` in this file to carry `refId`: add `refId: item.refId ?? null,` to the returned object.

- [ ] **Step 5: Add the Dynamo half to the test (before the summary line)**

```typescript
  const { DynamoByotStore } = await import("../../src/dynamo-byot-store.js");
  const t = new Map<string, any>();
  const fake = { async send(cmd: any) {
    const n = cmd.constructor.name; const key = (k: any) => `${k.pk}|${k.sk}`;
    if (n === "PutCommand") { t.set(key(cmd.input.Item), cmd.input.Item); return {}; }
    if (n === "GetCommand") { return { Item: t.get(key(cmd.input.Key)) }; }
    if (n === "DeleteCommand") { t.delete(key(cmd.input.Key)); return {}; }
    if (n === "ScanCommand") { return { Items: [...t.values()].filter(i => i.sk === "TOKEN" && String(i.pk).startsWith("SHARED#")) }; }
    throw new Error("unexpected " + n);
  } } as any;
  const dyn = new DynamoByotStore({ tableName: "jaid-byot", region: "eu-west-1", client: fake });
  await dyn.putShared({ poolId: "p1", name: "n", region: "eu-west-2", ciphertext: "C", last4: "1234", status: "active", createdAt: "t0", updatedAt: "t0" });
  ok("dynamo getShared", (await dyn.getShared("p1"))?.ciphertext === "C");
  ok("dynamo listShared", (await dyn.listShared()).length === 1);
  await dyn.deleteShared("p1");
  ok("dynamo deleteShared", (await dyn.getShared("p1")) === null);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_byot_shared_reference.ts`
Expected: `ALL PASS (9/9)`.

- [ ] **Step 7: Commit**

```bash
git add src/byot-store.ts src/dynamo-byot-store.ts hooks/tests/test_byot_shared_reference.ts
git commit -m "feat(invite): shared-token storage on ByotStore (SHARED# partition)"
```

---

### Task A6: ByotService shared-token ops + writeReference

**Files:**
- Modify: `src/byot/byot-service.ts`
- Test: append to `hooks/tests/test_byot_shared_reference.ts` (service half)

- [ ] **Step 1: Add the failing service test (before the summary line)**

```typescript
  const { ByotService } = await import("../../src/byot/byot-service.js");
  const { FakeByotCrypto } = await import("../../src/byot/byot-crypto.js");
  const memStore = new (await import("../../src/byot-store.js")).InMemoryByotStore();
  const okProbe = async () => ({ ok: true, results: [] } as any);
  const svc = new ByotService({
    store: memStore, crypto: new FakeByotCrypto(),
    models: { judgeModel: "j", embeddingModel: "e" }, probe: okProbe,
  });

  const created = await svc.createShared("Team", "bedrock-token-XYZ1234", "eu-west-2");
  ok("createShared stores + returns poolId", created.stored === true && !!created.poolId);
  const views = await svc.listShared();
  ok("listShared hides ciphertext, shows last4", views[0].last4 === "1234" && !(views[0] as any).ciphertext);

  await svc.writeReference("invite:zzz", created.poolId!);
  const ref = await memStore.get("invite:zzz");
  ok("writeReference writes a ref row", ref?.provider === "bedrock-bearer-ref" && ref?.refId === created.poolId);

  const badProbe = async () => ({ ok: false, results: [{ model: "j", ok: false, error: "denied" }] } as any);
  const svc2 = new ByotService({ store: memStore, crypto: new FakeByotCrypto(), models: { judgeModel: "j", embeddingModel: "e" }, probe: badProbe });
  ok("createShared rejects a bad token", (await svc2.createShared("Bad", "tok", "eu-west-2")).stored === false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_byot_shared_reference.ts`
Expected: FAIL — `svc.createShared is not a function`.

- [ ] **Step 3: Implement the service methods**

Add to `src/byot/byot-service.ts`. First extend the type import:

```typescript
import type { ByotActor, ByotConfigRecord, ByotConfigStatusView, SharedTokenRecord, SharedTokenView } from "./types.js";
import { randomBytes } from "node:crypto";
```

Add a stable crypto context helper near the top of the file (module scope):

```typescript
/** Encryption context for a shared token. Keyed on poolId (immutable across
 *  rotation) so the KMS context stays stable when the token value changes. */
const sharedCtx = (poolId: string) => ({ ownerSub: "shared:" + poolId });
```

Add these methods to the `ByotService` class:

```typescript
  /** Validate + encrypt + store a new shared/pooled token. Returns the
   *  generated poolId on success; stores nothing on probe failure. */
  async createShared(
    name: string, token: string, region: string,
  ): Promise<{ stored: boolean; poolId?: string; probe: ProbeResult }> {
    const probe = await (this.opts.probe ?? probeRegionCapabilities)(token, region, this.opts.models);
    if (!probe.ok) return { stored: false, probe };
    const poolId = randomBytes(8).toString("hex");
    const now = new Date().toISOString();
    const ciphertext = await this.opts.crypto.encrypt(token, sharedCtx(poolId));
    const record: SharedTokenRecord = {
      poolId, name, region, ciphertext, last4: token.slice(-4),
      status: "active", createdAt: now, updatedAt: now,
    };
    await this.opts.store.putShared(record);
    return { stored: true, poolId, probe };
  }

  /** Rotate the token value of an existing pool, preserving poolId (so every
   *  referencing invitee picks up the new token within one cache TTL). */
  async rotateShared(
    poolId: string, token: string, region: string,
  ): Promise<{ stored: boolean; probe: ProbeResult }> {
    const probe = await (this.opts.probe ?? probeRegionCapabilities)(token, region, this.opts.models);
    if (!probe.ok) return { stored: false, probe };
    const existing = await this.opts.store.getShared(poolId);
    if (!existing) return { stored: false, probe };
    const now = new Date().toISOString();
    const ciphertext = await this.opts.crypto.encrypt(token, sharedCtx(poolId));
    await this.opts.store.putShared({
      ...existing, region, ciphertext, last4: token.slice(-4), status: "active", updatedAt: now,
    });
    return { stored: true, probe };
  }

  async listShared(): Promise<SharedTokenView[]> {
    const rows = await this.opts.store.listShared();
    return rows.map((r) => ({
      poolId: r.poolId, name: r.name, region: r.region, last4: r.last4,
      status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt,
    }));
  }

  async removeShared(poolId: string): Promise<void> {
    await this.opts.store.deleteShared(poolId);
  }

  /** Write a reference row under an invitee's ownerSub pointing at a shared
   *  token. Resolved one hop at credential-resolve time. */
  async writeReference(ownerSub: string, poolId: string): Promise<void> {
    const shared = await this.opts.store.getShared(poolId);
    if (!shared) throw new Error(`shared token ${poolId} not found`);
    const now = new Date().toISOString();
    const record: ByotConfigRecord = {
      ownerSub, provider: "bedrock-bearer-ref", refId: poolId,
      region: "", ciphertext: "", last4: shared.last4, status: "active",
      createdAt: now, updatedAt: now, lastValidatedAt: now,
      lastFallbackAt: null, lastFallbackReason: null,
      setByAdminSub: null, setByAdminEmail: null, setByAdminAt: null,
    };
    await this.opts.store.put(record);
    this.opts.onChange?.(ownerSub);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_byot_shared_reference.ts`
Expected: `ALL PASS (14/14)`.

> Note: confirm `ProbeResult` has an `ok` boolean and `probeRegionCapabilities(token, region, models)` signature by checking `src/byot/capability-probe.ts`. If the success-shape differs, adjust the `okProbe`/`badProbe` stubs in the test accordingly — the production code only reads `probe.ok`.

- [ ] **Step 5: Commit**

```bash
git add src/byot/byot-service.ts hooks/tests/test_byot_shared_reference.ts
git commit -m "feat(invite): shared-token CRUD + writeReference on ByotService"
```

---

### Task A7: InviteService create/list/revoke

**Files:**
- Create: `src/invite-service.ts`
- Test: `hooks/tests/test_invite_redeem.ts` (create/list/revoke half; redeem added in Phase B)

- [ ] **Step 1: Write the failing test**

```typescript
// hooks/tests/test_invite_redeem.ts
// Run: npx tsx hooks/tests/test_invite_redeem.ts
import { InviteService } from "../../src/invite-service.js";
import { InMemoryInviteStore } from "../../src/invite-store.js";
import { InMemoryApiKeyStore } from "../../src/api-key-store.js";
import { InMemoryByotStore } from "../../src/byot-store.js";
import { ByotService } from "../../src/byot/byot-service.js";
import { FakeByotCrypto } from "../../src/byot/byot-crypto.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

function makeService() {
  const invites = new InMemoryInviteStore();
  const apiKeys = new InMemoryApiKeyStore();
  const byotStore = new InMemoryByotStore();
  const byot = new ByotService({
    store: byotStore, crypto: new FakeByotCrypto(),
    models: { judgeModel: "j", embeddingModel: "e" }, probe: async () => ({ ok: true, results: [] } as any),
  });
  const svc = new InviteService({ invites, apiKeys, byot, dashboardOrigin: "https://dredd.acta.io" });
  return { svc, invites, apiKeys, byotStore, byot };
}

async function main() {
  const { svc } = makeService();
  const created = await svc.createInvite({ email: "alice@example.com", createdBySub: "admin_1", createdByEmail: "a@x.io", expiresInHours: 1 });
  ok("createInvite returns a fragment URL", created.url === `https://dredd.acta.io/invite#${created.plaintextToken}`);
  ok("URL carries the token in the fragment (not path/query)", created.url.includes("#") && !created.url.includes("?"));

  const list = await svc.listInvites();
  ok("listInvites returns the invite", list.length === 1 && list[0].email === "alice@example.com");

  ok("revoke succeeds", (await svc.revokeInvite(created.record.tokenHash, "admin_1")) === true);
  ok("revoked shows in list as revoked", (await svc.listInvites())[0].status === "revoked");

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_invite_redeem.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation (create/list/revoke; `redeem` stub added in B2)**

```typescript
// src/invite-service.ts
/**
 * Invite orchestration. The only unit that fans across stores: invites +
 * api-keys + BYOT + the bundle builder. Everything it calls stays
 * single-purpose. See docs/superpowers/specs/2026-06-02-invite-links-design.md.
 */
import type { InviteStore, InviteRecord, CreateInviteInput } from "./invite-store.js";
import type { ApiKeyStore } from "./api-key-store.js";
import type { ByotService } from "./byot/byot-service.js";
import { syntheticSubForEmail } from "./owner-identity.js";
import { buildIntegrationBundle } from "./integration-bundle.js";

export interface InviteServiceOptions {
  invites: InviteStore;
  apiKeys: ApiKeyStore;
  byot: ByotService;
  /** Origin the redemption link is hosted on, e.g. https://dredd.acta.io. */
  dashboardOrigin: string;
}

export interface CreatedInvite {
  record: InviteRecord;
  plaintextToken: string;
  /** Token rides in the fragment so it never reaches the server on GET. */
  url: string;
}

export interface RedeemOutcome {
  ok: boolean;
  email?: string;
  plaintextKey?: string;
  bundleBase64?: string;
}

export class InviteService {
  constructor(private readonly opts: InviteServiceOptions) {}

  async createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
    const { record, plaintextToken } = await this.opts.invites.createInvite(input);
    const url = `${this.opts.dashboardOrigin}/invite#${plaintextToken}`;
    return { record, plaintextToken, url };
  }

  async listInvites(limit?: number): Promise<InviteRecord[]> {
    return this.opts.invites.listAll(limit);
  }

  async revokeInvite(tokenHash: string, by: string): Promise<boolean> {
    return this.opts.invites.revoke(tokenHash, by);
  }

  /** Peek — validate without consuming. Returns the display fields the
   *  redemption page needs, or null for any invalid/expired/used token
   *  (the caller renders one generic message). */
  async peek(plaintextToken: string): Promise<{ email: string; expiresAt: number } | null> {
    const inv = await this.opts.invites.findByToken(plaintextToken);
    if (!inv || inv.status !== "pending" || inv.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return { email: inv.email, expiresAt: inv.expiresAt };
  }

  // redeemInvite is implemented in Task B2.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_invite_redeem.ts`
Expected: `ALL PASS (5/5)`.

- [ ] **Step 5: Commit**

```bash
git add src/invite-service.ts hooks/tests/test_invite_redeem.ts
git commit -m "feat(invite): InviteService create/list/revoke/peek"
```

---

### Task A8: Wire stores into server-core

**Files:**
- Modify: `src/server-core.ts` (after the `byotService` block, ~line 700)

- [ ] **Step 1: Add the wiring**

Add imports near the other store imports:

```typescript
import { InMemoryInviteStore, type InviteStore } from "./invite-store.js";
import { DynamoInviteStore } from "./dynamo-invite-store.js";
import { InviteService } from "./invite-service.js";
```

After the `byotService` construction, add:

```typescript
// ---------------------------------------------------------------------------
// Invites — one-time, no-auth onboarding links. Table jaid-invites.
// ---------------------------------------------------------------------------
export const DYNAMO_INVITES_TABLE_NAME =
  process.env.DYNAMO_INVITES_TABLE_NAME ?? "jaid-invites";

export const inviteStore: InviteStore = STORE_BACKEND === "dynamo"
  ? new DynamoInviteStore({ tableName: DYNAMO_INVITES_TABLE_NAME, region: DYNAMO_REGION })
  : new InMemoryInviteStore();

/** Origin the redemption link is hosted on (the dashboard). Falls back to
 *  the dashboard origin env or empty (route fills from the request Host). */
export const DASHBOARD_ORIGIN = process.env.DREDD_DASHBOARD_ORIGIN ?? "";

export const inviteService = new InviteService({
  invites: inviteStore,
  apiKeys,
  byot: byotService,
  dashboardOrigin: DASHBOARD_ORIGIN,
});

console.log(`  [INVITE] store: ${STORE_BACKEND} (table=${DYNAMO_INVITES_TABLE_NAME})`);
```

- [ ] **Step 2: Verify it compiles + the server boots**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `STORE_BACKEND=memory npm run server` (Ctrl-C after the banner)
Expected: startup banner includes `[INVITE] store: memory (table=jaid-invites)`.

- [ ] **Step 3: Commit**

```bash
git add src/server-core.ts
git commit -m "feat(invite): wire inviteStore + inviteService into server-core"
```

---

### Task A9: Admin endpoints (`/api/invites`, `/api/shared-tokens`)

**Files:**
- Modify: `src/server-dashboard.ts` (after the `/api/byot` block, ~line 575)

The dashboard `requireClerkAuth` returns a principal with `isAdmin`. Use the same `json` / `readBody` helpers and admin guard already in this file. Build the link from the request Host when `DASHBOARD_ORIGIN` is empty.

- [ ] **Step 1: Add the route block**

Add the import:

```typescript
import { inviteService, byotService, inviteStore, DASHBOARD_ORIGIN } from "./server-core.js";
```
(Merge with the existing `server-core` import — `byotService` is likely already imported.)

Insert after the `/api/byot` handler:

```typescript
    // ---------------------------------------------------------------
    // Admin invites — generate / list / revoke one-time onboarding links.
    // ---------------------------------------------------------------
    if (url.pathname === "/api/invites") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (!principal.isAdmin) return json(res, 403, { error: "Admin only" });

      if (req.method === "GET") {
        return json(res, 200, await inviteService.listInvites());
      }
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const email = String(body.email ?? "").trim();
        if (!email || !email.includes("@")) return json(res, 400, { error: "Valid email required" });
        const expiresInHours = Math.min(Math.max(Number(body.expiresInHours ?? 1), 0.25), 24);
        const sharedTokenId = body.sharedTokenId ? String(body.sharedTokenId) : null;
        if (sharedTokenId && !(await byotService.listShared()).some((s) => s.poolId === sharedTokenId)) {
          return json(res, 400, { error: "Unknown shared token" });
        }
        // Prefer a configured origin; else derive from this request.
        const origin = DASHBOARD_ORIGIN || `https://${req.headers.host}`;
        const created = await inviteService.createInvite({
          email, createdBySub: principal.userId, createdByEmail: principal.email || null,
          expiresInHours, sharedTokenId,
        });
        // url already built against DASHBOARD_ORIGIN; if empty, rebuild here.
        const urlOut = DASHBOARD_ORIGIN ? created.url : `${origin}/invite#${created.plaintextToken}`;
        return json(res, 200, { url: urlOut, record: created.record });
      }
      return json(res, 405, { error: "Method not allowed" });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/invites/")) {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (!principal.isAdmin) return json(res, 403, { error: "Admin only" });
      const tokenHash = url.pathname.split("/api/invites/")[1];
      if (!tokenHash || !/^[a-f0-9]{64}$/.test(tokenHash)) return json(res, 400, { error: "Invalid id" });
      return json(res, 200, { revoked: await inviteService.revokeInvite(tokenHash, principal.userId) });
    }

    // ---------------------------------------------------------------
    // Admin shared/pooled BYOT tokens.
    // ---------------------------------------------------------------
    if (url.pathname === "/api/shared-tokens") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (!principal.isAdmin) return json(res, 403, { error: "Admin only" });

      if (req.method === "GET") {
        const views = await byotService.listShared();
        const invites = await inviteService.listInvites();
        const withCounts = views.map((v) => ({
          ...v, refCount: invites.filter((i) => i.sharedTokenId === v.poolId && i.status !== "revoked").length,
        }));
        return json(res, 200, withCounts);
      }
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const name = String(body.name ?? "").slice(0, 128) || "Shared token";
        const token = String(body.token ?? "");
        const region = String(body.region ?? "");
        if (!token || !region) return json(res, 400, { error: "token and region required" });
        const result = await byotService.createShared(name, token, region);
        if (!result.stored) return json(res, 400, { error: "Token failed capability probe", probe: result.probe });
        return json(res, 200, { poolId: result.poolId });
      }
      return json(res, 405, { error: "Method not allowed" });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/shared-tokens/")) {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (!principal.isAdmin) return json(res, 403, { error: "Admin only" });
      const poolId = url.pathname.split("/api/shared-tokens/")[1];
      if (!poolId || !/^[a-f0-9]{16}$/.test(poolId)) return json(res, 400, { error: "Invalid id" });
      await byotService.removeShared(poolId);
      return json(res, 200, { removed: true });
    }
```

- [ ] **Step 2: Verify compile + manual smoke (memory backend)**

Run: `npx tsc --noEmit` — no new errors.

Manual (requires a Clerk admin bearer `$T` and the dashboard running locally):
```bash
curl -s -XPOST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","expiresInHours":1}' localhost:3001/api/invites | jq
# Expect: { "url": "https://.../invite#<token>", "record": { "status": "pending", ... } }
curl -s -H "Authorization: Bearer $T" localhost:3001/api/invites | jq 'length'   # >= 1
```

- [ ] **Step 3: Commit**

```bash
git add src/server-dashboard.ts
git commit -m "feat(invite): admin endpoints for invites + shared tokens"
```

---

### Task A10: Terraform `jaid-invites` table + IAM

**Files:**
- Create: `terraform/jaid-invites.tf`
- Modify: `terraform/iam.tf` (dashboard task-role policy)

- [ ] **Step 1: Create the table**

```hcl
# terraform/jaid-invites.tf
# One-time, no-auth onboarding invite tokens. Single-use + TTL.
# pk = INVITE#<tokenHash>; GSI1 (gsi1pk="INVITE", gsi1sk=createdAt) for the
# admin list. TTL on `ttl` (~7d past expiry). Mirrors jaid-api-keys shape.
resource "aws_dynamodb_table" "jaid_invites" {
  name         = "jaid-invites"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = var.sse_kms_key_arn
  }

  tags = {
    Name = "jaid-invites"
  }
}
```

- [ ] **Step 2: Grant the dashboard task role access**

In `terraform/iam.tf`, find the dashboard task-role policy document (the `aws_iam_role_policy` near `${local.name_prefix}-dashboard-task`, ~line 377) and add the invites table + its index to the DynamoDB statement `resources`. Add to the relevant `Resource` list:

```hcl
      aws_dynamodb_table.jaid_invites.arn,
      "${aws_dynamodb_table.jaid_invites.arn}/index/*",
```
with actions covering `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`. (Match the existing statement's action style; if shared-token Scan on `jaid-byot` is not yet permitted, also add `dynamodb:Scan` on the `jaid-byot` ARN for `listShared`.)

- [ ] **Step 3: Validate**

Run: `cd terraform && tofu validate`
Expected: `Success! The configuration is valid.`

Run: `tofu plan` — review that it adds `aws_dynamodb_table.jaid_invites` and updates the dashboard policy only. Do NOT apply yet (apply happens in the rollout step).

- [ ] **Step 4: Commit**

```bash
git add terraform/jaid-invites.tf terraform/iam.tf
git commit -m "feat(invite): jaid-invites table + dashboard IAM grants"
```

---

### Task A11: Dashboard Invites tab + shared-tokens section

**Files:**
- Modify: `src/web/dashboard.html`

- [ ] **Step 1: Add the tab to the nav + `KNOWN_TABS`**

Find the tab bar (near `onclick="switchTab('integrate')"`) and add, gated to admins (mirror how an existing admin-only tab is shown/hidden — e.g. the logs tab visibility check):

```html
      <div class="tab admin-only" onclick="switchTab('invites')">Invites</div>
```

Add `'invites'` to the `KNOWN_TABS` array (near line 2404).

- [ ] **Step 2: Add the tab content**

After the integrate tab content div, add a `#tab-invites` content block containing:
- a **Generate invite** form: `email` text input, `expiresInHours` number input (default `1`), a `sharedTokenId` `<select>` populated from `GET /api/shared-tokens`, and a Generate button that POSTs to `/api/invites` and renders the returned `url` with a Copy button + "valid 1 hour, shown once" warning.
- an **Invites** table populated from `GET /api/invites`: email · status chip · created · expires · a Revoke button (DELETE `/api/invites/<tokenHash>`).
- a **Shared tokens** sub-section: a create form (name, token, region) POSTing to `/api/shared-tokens`, and a list from `GET /api/shared-tokens` showing `name`/`last4`/`region`/`status`/`refCount` with a Delete button (confirm when `refCount > 0`).

Reuse the existing `dreddFetch`, `copyCode`/copy helpers, and status-chip CSS already in the file. Keep all network calls behind the admin bearer (these endpoints 403 for non-admins, so a non-admin who forces the tab sees errors — acceptable; the tab is hidden for them).

- [ ] **Step 3: Manual verification**

Build + run the dashboard locally (or deploy to a test task), sign in as an admin:
- Generate an invite → a `…/invite#<token>` URL appears with Copy.
- The invite shows in the table as `pending`; Revoke flips it to `revoked`.
- Create a shared token (use a real Bedrock token + region) → it appears with `last4`; allocate it in the invite form's dropdown.

- [ ] **Step 4: Commit**

```bash
git add src/web/dashboard.html
git commit -m "feat(invite): dashboard Invites tab + shared-token management"
```

---

# PHASE B — Redemption

### Task B1: Pre-keyed integration bundle

**Files:**
- Modify: `src/integration-bundle.ts:545-565`
- Test: `hooks/tests/test_bundle_prekeyed.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// hooks/tests/test_bundle_prekeyed.ts
// Run: npx tsx hooks/tests/test_bundle_prekeyed.ts
import { buildIntegrationBundle } from "../../src/integration-bundle.js";
import { inflateRawSync } from "node:zlib";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

/** Return the set of entry names in a zip produced by buildZip (local
 *  headers carry the name at a fixed offset; scan for the 0x04034b50 sig). */
function entryNames(buf: Buffer): string[] {
  const names: string[] = [];
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) === 0x04034b50) {
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const compLen = buf.readUInt32LE(i + 18);
      names.push(buf.toString("utf8", i + 30, i + 30 + nameLen));
      i += 30 + nameLen + extraLen + compLen;
    } else break;
  }
  return names;
}

function main() {
  const plain = buildIntegrationBundle("https://dredd-hook.acta.io");
  ok("plain bundle has no api-key file", !entryNames(plain).includes("dredd/api-key"));

  const keyed = buildIntegrationBundle("https://dredd-hook.acta.io", "jaid_live_TESTKEY");
  ok("keyed bundle includes dredd/api-key", entryNames(keyed).includes("dredd/api-key"));
  ok("keyed bundle still includes the hook", entryNames(keyed).includes("dredd-hook.sh"));

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_bundle_prekeyed.ts`
Expected: FAIL — `keyed bundle includes dredd/api-key` (the optional param doesn't exist yet).

- [ ] **Step 3: Add the optional `apiKey` param**

In `src/integration-bundle.ts`, change the signature + entry list (around line 545):

```typescript
export function buildIntegrationBundle(dreddUrl: string, apiKey?: string): Buffer {
  const bakedHook = buildBakedHook(dreddUrl);

  const entries: ZipEntry[] = [
    { name: "dredd-hook.sh", data: Buffer.from(bakedHook, "utf8"), mode: 0o755 },
    { name: "claude-install-prompt.txt", data: Buffer.from(renderInstallPrompt(dreddUrl), "utf8"), mode: 0o644 },
    { name: "settings.json", data: Buffer.from(renderSettings(dreddUrl), "utf8"), mode: 0o644 },
    { name: "README.md", data: Buffer.from(renderReadme(dreddUrl, !!apiKey), "utf8"), mode: 0o644 },
  ];

  // Pre-keyed bundle (invite redemption): drop the live key in at 0600 so the
  // user copies it straight to ~/.claude/dredd/api-key. Built transiently —
  // never persisted server-side.
  if (apiKey) {
    entries.push({ name: "dredd/api-key", data: Buffer.from(apiKey + "\n", "utf8"), mode: 0o600 });
  }

  const skill = readSkillEntrySafe("working-with-dredd-judge/SKILL.md");
  if (skill) entries.push(skill);

  return buildZip(entries);
}
```

Update `renderReadme` to accept a `prekeyed` flag and rewrite step 1 when true. Change its signature to `function renderReadme(dreddUrl: string, prekeyed = false): string` and make the "## 1. Generate & install your API key" section conditional:

```typescript
  const stepOne = prekeyed
    ? `## 1. Install your API key

Your key is already in this bundle at \`dredd/api-key\`. Copy it into place:

\`\`\`bash
mkdir -p ~/.claude/dredd
cp dredd/api-key ~/.claude/dredd/api-key
chmod 600 ~/.claude/dredd/api-key
\`\`\`

Treat this bundle as a secret — it contains a live key.`
    : `## 1. Generate & install your API key

The hook server requires a Bearer key on every request. Without one,
\`/intent\` and \`/evaluate\` return 401 and Dredd silently allows everything.

Open the dashboard's **API Keys** tab → **Generate key** and run the snippet
shown in the banner:

\`\`\`bash
printf '%s\\n' 'jaid_live_PASTE_KEY_HERE' > ~/.claude/dredd/api-key
chmod 600 ~/.claude/dredd/api-key
\`\`\``;
```

Then interpolate `${stepOne}` where the old step-1 text was. (Confirm the existing README template literal location around line 147-247 and splice `stepOne` in place of the current section.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_bundle_prekeyed.ts`
Expected: `ALL PASS (3/3)`.

- [ ] **Step 5: Commit**

```bash
git add src/integration-bundle.ts hooks/tests/test_bundle_prekeyed.ts
git commit -m "feat(invite): optional key-baked integration bundle"
```

---

### Task B2: InviteService.redeemInvite (atomic)

**Files:**
- Modify: `src/invite-service.ts`
- Test: append to `hooks/tests/test_invite_redeem.ts`

- [ ] **Step 1: Add the failing redeem tests (before the summary line)**

```typescript
  // ---- redeem: happy path ----
  {
    const { svc, apiKeys, byotStore, byot } = makeService();
    const sh = await byot.createShared("Team", "bedrock-token-9999", "eu-west-2");
    const inv = await svc.createInvite({ email: "bob@example.com", createdBySub: "admin_1", createdByEmail: null, expiresInHours: 1, sharedTokenId: sh.poolId! });
    const out = await svc.redeemInvite(inv.plaintextToken, "https://dredd-hook.acta.io");
    ok("redeem ok", out.ok === true && out.email === "bob@example.com");
    ok("redeem returns a plaintext key", !!out.plaintextKey && out.plaintextKey!.startsWith("jaid_live_"));
    ok("redeem returns a bundle", typeof out.bundleBase64 === "string" && out.bundleBase64!.length > 100);
    const sub = "invite:" + (await import("node:crypto")).createHash("sha256").update("bob@example.com").digest("hex").slice(0, 32);
    ok("key minted under synthetic sub", (await apiKeys.listByOwner(sub)).length === 1);
    ok("BYOT reference written", (await byotStore.get(sub))?.provider === "bedrock-bearer-ref");
    ok("second redeem loses (single-use)", (await svc.redeemInvite(inv.plaintextToken, "https://x")).ok === false);
  }
  // ---- redeem: expired / revoked / unknown all fail generically ----
  {
    const { svc } = makeService();
    ok("unknown token fails", (await svc.redeemInvite("not-a-token", "https://x")).ok === false);
    const r = await svc.createInvite({ email: "c@x.io", createdBySub: "a", createdByEmail: null });
    await svc.revokeInvite(r.record.tokenHash, "a");
    ok("revoked token fails", (await svc.redeemInvite(r.plaintextToken, "https://x")).ok === false);
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_invite_redeem.ts`
Expected: FAIL — `svc.redeemInvite is not a function`.

- [ ] **Step 3: Implement `redeemInvite`**

Replace the `// redeemInvite is implemented in Task B2.` comment in `src/invite-service.ts` with:

```typescript
  /**
   * Atomic redemption. Order matters (spec §7): lock FIRST (so a race or a
   * replay never mints a second key), then mint the key, write the BYOT
   * reference, stamp traceability, and build the key-baked bundle. Any
   * invalid/expired/used/unknown token returns { ok: false } with no copy
   * that distinguishes the cases (no enumeration).
   */
  async redeemInvite(plaintextToken: string, dreddUrl: string): Promise<RedeemOutcome> {
    // Read first to recover email + sharedTokenId for the post-lock steps.
    const invite = await this.opts.invites.findByToken(plaintextToken);
    if (!invite || invite.status !== "pending" || invite.expiresAt <= Math.floor(Date.now() / 1000)) {
      return { ok: false };
    }

    // The single-use lock. Loser of a race / replay gets null here.
    const won = await this.opts.invites.consume(plaintextToken, new Date().toISOString());
    if (!won) return { ok: false };

    const email = invite.email;
    const ownerSub = syntheticSubForEmail(email);

    const generated = await this.opts.apiKeys.generateKey({
      ownerSub, ownerEmail: email, description: `Invite for ${email}`, keyType: "invited",
    });

    if (invite.sharedTokenId) {
      try {
        await this.opts.byot.writeReference(ownerSub, invite.sharedTokenId);
      } catch (err) {
        // Shared token vanished between create and redeem — proceed without
        // BYOT (sessions fall back to the platform role). Logged, not fatal.
        console.warn(`[invite] writeReference failed for ${invite.sharedTokenId}: ${(err as Error)?.message ?? err}`);
      }
    }

    // Best-effort traceability stamp.
    await this.opts.invites.stampResult(won.tokenHash, {
      resultingKeyHash: generated.hashedKey, resultingOwnerSub: ownerSub,
    });

    const bundle = buildIntegrationBundle(dreddUrl, generated.plaintext);
    return {
      ok: true, email,
      plaintextKey: generated.plaintext,
      bundleBase64: bundle.toString("base64"),
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_invite_redeem.ts`
Expected: `ALL PASS (14/14)`.

- [ ] **Step 5: Commit**

```bash
git add src/invite-service.ts hooks/tests/test_invite_redeem.ts
git commit -m "feat(invite): atomic redeemInvite (lock → mint → reference → bundle)"
```

---

### Task B3: Public redemption endpoints

**Files:**
- Modify: `src/server-dashboard.ts` (in the unauthenticated block, near `/api/health`, ~line 108)

These MUST be registered **before** any `requireClerkAuth` so they stay public. The token arrives in the POST body (read from `location.hash` client-side), never in the URL path/query.

- [ ] **Step 1: Add the public routes**

Add to the server-core import: `inviteService`. Then in the unauthenticated section:

```typescript
    // Public: redemption page shell. No token in the request — it rides in
    // the URL fragment and is read by the page JS, which POSTs it back.
    if (req.method === "GET" && url.pathname === "/invite") {
      const { renderRedemptionPage } = await import("./invite-page.js");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(renderRedemptionPage());
    }

    // Public: peek — validate without consuming. Generic invalid otherwise.
    if (req.method === "POST" && url.pathname === "/api/invite/peek") {
      const body = JSON.parse(await readBody(req));
      const token = String(body.token ?? "");
      const peeked = await inviteService.peek(token);
      if (!peeked) return json(res, 404, { valid: false, error: "This invite link is invalid or has expired." });
      return json(res, 200, { valid: true, email: peeked.email, expiresAt: peeked.expiresAt });
    }

    // Public: redeem — single-use consume. Returns key + bundle once.
    if (req.method === "POST" && url.pathname === "/api/invite/redeem") {
      const body = JSON.parse(await readBody(req));
      const token = String(body.token ?? "");
      const dreddUrl = HOOK_URL || resolvePublicOrigin(req);
      const outcome = await inviteService.redeemInvite(token, dreddUrl);
      if (!outcome.ok) return json(res, 409, { ok: false, error: "This invite link is invalid, expired, or already used." });
      return json(res, 200, {
        ok: true, email: outcome.email, apiKey: outcome.plaintextKey, bundleBase64: outcome.bundleBase64,
      });
    }
```

(`resolvePublicOrigin` is already used by the integration-bundle route in this file; reuse it. If the file lacks `HOOK_URL` in scope at this point, it's defined at module top, line 58.)

- [ ] **Step 2: Add a basic per-IP rate limit guard**

Above the routes, add a tiny in-memory limiter (the hot path already has `getClientIp`; the dashboard can use a minimal version reading the same trailing XFF hop):

```typescript
const inviteHits = new Map<string, { n: number; resetAt: number }>();
function inviteRateLimited(req: IncomingMessage): boolean {
  const ip = (req.headers["x-forwarded-for"]?.toString().split(",").pop() ?? "unknown").trim();
  const now = Date.now();
  const e = inviteHits.get(ip);
  if (!e || e.resetAt < now) { inviteHits.set(ip, { n: 1, resetAt: now + 60_000 }); return false; }
  e.n += 1;
  return e.n > 30; // 30 invite requests / IP / minute
}
```

Guard the peek + redeem routes: `if (inviteRateLimited(req)) return json(res, 429, { error: "Too many requests" });` as the first line of each.

- [ ] **Step 3: Verify compile**

Run: `npx tsc --noEmit` — no new errors (the `invite-page.js` import resolves once Task B4 lands; do B4 before running the server).

- [ ] **Step 4: Commit**

```bash
git add src/server-dashboard.ts
git commit -m "feat(invite): public peek/redeem endpoints (fragment token, rate-limited)"
```

---

### Task B4: Redemption page

**Files:**
- Create: `src/invite-page.ts`

- [ ] **Step 1: Write the page renderer**

```typescript
// src/invite-page.ts
/**
 * Standalone, unauthenticated redemption page. NOT the gated dashboard
 * shell. The invite token is in the URL fragment (location.hash) and is
 * never sent on this GET — the page reads it client-side and POSTs it to
 * /api/invite/peek (validate) then /api/invite/redeem (consume) on click.
 */
export function renderRedemptionPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>Install Judge AI Dredd</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background:#0b0d10; color:#e6e6e6; margin:0; }
  .wrap { max-width: 640px; margin: 8vh auto; padding: 0 20px; }
  .card { background:#15181d; border:1px solid #262b33; border-radius:10px; padding:24px; }
  h1 { font-size:20px; margin:0 0 8px; } .muted { color:#9aa3ad; font-size:13px; }
  button { background:#2d6cdf; color:#fff; border:0; border-radius:6px; padding:10px 16px; font-size:14px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  pre { background:#0b0d10; border:1px solid #262b33; border-radius:6px; padding:12px; overflow:auto; white-space:pre-wrap; word-break:break-all; }
  .warn { color:#f0b429; } .err { color:#f06464; } .hidden { display:none; }
  code { color:#9ad; }
</style></head>
<body><div class="wrap"><div class="card">
  <h1>Install Judge AI Dredd</h1>
  <div id="status" class="muted">Checking your invite…</div>

  <div id="ready" class="hidden">
    <p class="muted">You've been invited as <strong id="who"></strong>. This link works <strong>once</strong>. Click below to reveal your key and download your install bundle.</p>
    <button id="go">Reveal my key &amp; download</button>
  </div>

  <div id="result" class="hidden">
    <p class="warn">Keep this secret. Your API key:</p>
    <pre id="key"></pre>
    <button id="dl">Download install bundle (.zip)</button>
    <p class="muted">Then: unzip it, run <code>cp dredd/api-key ~/.claude/dredd/api-key &amp;&amp; chmod 600 ~/.claude/dredd/api-key</code>, copy <code>dredd-hook.sh</code> into <code>~/.claude/dredd/</code>, merge <code>settings.json</code> into <code>~/.claude/settings.json</code>, and restart Claude Code. Full steps are in the bundle's <code>README.md</code>.</p>
  </div>
</div></div>
<script>
  const token = location.hash.slice(1);
  const $ = (id) => document.getElementById(id);
  async function peek() {
    if (!token) { $("status").innerHTML = '<span class="err">No invite token in the link.</span>'; return; }
    const r = await fetch("/api/invite/peek", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const d = await r.json();
    if (!r.ok || !d.valid) { $("status").innerHTML = '<span class="err">' + (d.error || "Invalid or expired invite.") + '</span>'; return; }
    $("status").classList.add("hidden"); $("who").textContent = d.email; $("ready").classList.remove("hidden");
  }
  $("go").onclick = async () => {
    $("go").disabled = true;
    const r = await fetch("/api/invite/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const d = await r.json();
    if (!r.ok || !d.ok) { $("status").classList.remove("hidden"); $("status").innerHTML = '<span class="err">' + (d.error || "Redemption failed.") + '</span>'; $("ready").classList.add("hidden"); return; }
    $("ready").classList.add("hidden"); $("key").textContent = d.apiKey; $("result").classList.remove("hidden");
    $("dl").onclick = () => {
      const bin = atob(d.bundleBase64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const a = document.createElement("a"); a.href = url; a.download = "judge-dredd-integration.zip"; a.click();
      URL.revokeObjectURL(url);
    };
  };
  peek();
</script>
</body></html>`;
}
```

- [ ] **Step 2: Verify compile + boot**

Run: `npx tsc --noEmit` — no new errors.
Run the dashboard locally; in a browser open `http://localhost:3001/invite#<token>` for a token created via `/api/invites`. Expect "invited as <email>" → click → key + working bundle download. Refresh → "invalid, expired, or already used" (single-use confirmed).

- [ ] **Step 3: Commit**

```bash
git add src/invite-page.ts
git commit -m "feat(invite): standalone redemption page (fragment token, one-time)"
```

---

# PHASE C — Hot-path BYOT reference resolution

### Task C1: One-hop reference follow in BearerCredentialProvider

**Files:**
- Modify: `src/byot/credential-provider.ts:52-71`
- Test: append to `hooks/tests/test_byot_shared_reference.ts`

- [ ] **Step 1: Add the failing resolution test (before the summary line)**

```typescript
  // ---- credential-provider one-hop follow ----
  {
    const { BearerCredentialProvider } = await import("../../src/byot/credential-provider.js");
    const { FakeByotCrypto } = await import("../../src/byot/byot-crypto.js");
    const store = new (await import("../../src/byot-store.js")).InMemoryByotStore();
    const crypto = new FakeByotCrypto();
    // Seed a shared token (encrypt with the same context the provider uses).
    const ct = await crypto.encrypt("REAL-TOKEN", { ownerSub: "shared:pool_x" });
    await store.putShared({ poolId: "pool_x", name: "n", region: "eu-west-2", ciphertext: ct, last4: "OKEN", status: "active", createdAt: "t", updatedAt: "t" });
    // Invitee reference row.
    await store.put({ ownerSub: "invite:abc", provider: "bedrock-bearer-ref", refId: "pool_x", region: "", ciphertext: "", last4: "OKEN", status: "active", createdAt: "t", updatedAt: "t", lastValidatedAt: "t" });

    const prov = new BearerCredentialProvider({ store, crypto });
    const auth = await prov.resolve("invite:abc");
    ok("ref resolves to the shared token", auth.kind === "bearer" && auth.token === "REAL-TOKEN" && auth.region === "eu-west-2");

    // Direct token still works (regression).
    const ct2 = await crypto.encrypt("OWN-TOKEN", { ownerSub: "user_own" });
    await store.put({ ownerSub: "user_own", provider: "bedrock-bearer", region: "eu-west-1", ciphertext: ct2, last4: "OKEN", status: "active", createdAt: "t", updatedAt: "t", lastValidatedAt: "t" });
    const auth2 = await prov.resolve("user_own");
    ok("own token still resolves", auth2.kind === "bearer" && auth2.token === "OWN-TOKEN");

    // Missing shared row → default (fail-soft), not throw.
    await store.put({ ownerSub: "invite:dangling", provider: "bedrock-bearer-ref", refId: "gone", region: "", ciphertext: "", last4: "", status: "active", createdAt: "t", updatedAt: "t", lastValidatedAt: "t" });
    ok("dangling ref → default", (await prov.resolve("invite:dangling")).kind === "default");
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_byot_shared_reference.ts`
Expected: FAIL — `ref resolves to the shared token` (provider doesn't follow refs yet).

- [ ] **Step 3: Implement the one-hop follow**

In `src/byot/credential-provider.ts`, replace the body of the `try` block in `resolve` (lines ~58-63) with:

```typescript
      const rec = await this.store.get(ownerSub);
      if (rec && rec.provider === "bedrock-bearer") {
        const token = await this.crypto.decrypt(rec.ciphertext, { ownerSub });
        auth = { kind: "bearer", token, region: rec.region };
      } else if (rec && rec.provider === "bedrock-bearer-ref" && rec.refId) {
        // Exactly one hop. getShared only ever returns token rows, so a ref
        // can never resolve to another ref — no cycles, no fan-out.
        const shared = await this.store.getShared(rec.refId);
        if (shared) {
          const token = await this.crypto.decrypt(shared.ciphertext, { ownerSub: "shared:" + rec.refId });
          auth = { kind: "bearer", token, region: shared.region };
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_byot_shared_reference.ts`
Expected: `ALL PASS (17/17)`.

Also re-run the existing BYOT provider test to confirm no regression:
Run: `npx tsx hooks/tests/test_byot_provider.ts`
Expected: still `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/byot/credential-provider.ts hooks/tests/test_byot_shared_reference.ts
git commit -m "feat(invite): one-hop shared-token resolution in BearerCredentialProvider"
```

---

# PHASE D — Identity reconciliation (dashboard read-path)

### Task D1: Match both subs for a signed-in principal

**Files:**
- Modify: `src/server-dashboard.ts` (the `/api/sessions`, `/api/keys` GET, `/api/byot` GET handlers)
- Test: `hooks/tests/test_invite_reconcile.ts`

The hot path always stamps the invited user's sessions/keys under the
email-sub, so reconciliation is purely a dashboard **read** concern: a
signed-in non-admin principal should see rows owned by EITHER their Clerk
userId OR `syntheticSubForEmail(their email)`.

- [ ] **Step 1: Write the failing test (pure matcher level)**

```typescript
// hooks/tests/test_invite_reconcile.ts
// Run: npx tsx hooks/tests/test_invite_reconcile.ts
import { ownerSubsForPrincipal, syntheticSubForEmail } from "../../src/owner-identity.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

function main() {
  const principal = { userId: "user_clerk_1", email: "alice@example.com" };
  const subs = new Set(ownerSubsForPrincipal(principal));

  // Sessions created during the invited (pre-sign-in) era.
  const invitedSession = { ownerSub: syntheticSubForEmail("alice@example.com") };
  // Sessions created after they signed in and generated a fresh key.
  const clerkSession = { ownerSub: "user_clerk_1" };
  // Someone else.
  const otherSession = { ownerSub: "user_clerk_2" };

  ok("matches invited-era session", subs.has(invitedSession.ownerSub));
  ok("matches post-signin session", subs.has(clerkSession.ownerSub));
  ok("does not match a stranger", !subs.has(otherSession.ownerSub));

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `npx tsx hooks/tests/test_invite_reconcile.ts`
Expected: `ALL PASS (3/3)` — the matcher from Task A1 already supports this. This test pins the reconciliation contract.

- [ ] **Step 3: Apply the matcher in the dashboard read-path**

In `src/server-dashboard.ts`:

- Import: `import { ownerSubsForPrincipal } from "./owner-identity.js";`

- **`/api/sessions`** (non-admin branch): where it currently filters sessions by `ownerSub === principal.userId`, replace with a set membership test:

```typescript
        const subs = new Set(ownerSubsForPrincipal(principal));
        all = all.filter((s) => subs.has(s.ownerSub));
```

- **`GET /api/keys`** (non-admin branch, line ~437): replace `listByOwner(principal.userId)` with a merge across both subs:

```typescript
        const subs = ownerSubsForPrincipal(principal);
        const lists = await Promise.all(subs.map((s) => apiKeys.listByOwner(s)));
        all = lists.flat();
```

- **`GET /api/byot`** (self branch): when the self-owned row is absent under `principal.userId`, also check the email-sub so a reconciled user sees their invited BYOT reference status:

```typescript
        let status = await byotService.getStatus(principal.userId);
        if (!status.configured) {
          for (const s of ownerSubsForPrincipal(principal)) {
            const alt = await byotService.getStatus(s);
            if (alt.configured) { status = alt; break; }
          }
        }
        return json(res, 200, status);
```

(Adjust to the exact local variable names in each handler. The DELETE/revoke
paths stay keyed on the explicit hash/sub — reconciliation is read-only.)

- [ ] **Step 4: Verify compile + manual check**

Run: `npx tsc --noEmit` — no new errors.
Manual: with a memory backend, mint an invite for `you@example.com`, redeem it (creates a key under `invite:<hash>`), then sign into the dashboard as a Clerk identity whose email is `you@example.com` → the invited key appears in the API Keys tab.

- [ ] **Step 5: Commit**

```bash
git add src/server-dashboard.ts hooks/tests/test_invite_reconcile.ts
git commit -m "feat(invite): reconcile invited identity in dashboard read-path"
```

---

# Rollout

After all phases are merged and green:

1. **Apply infra:** `cd terraform && tofu apply` — creates `jaid-invites`, updates the dashboard task-role policy.
2. **Build + deploy the dashboard image** (per CLAUDE.md "Building the Docker images locally" → push → `aws ecs update-service --force-new-deployment` on `judge-ai-dredd-prod-dashboard`). **Stage `skills/` into the build context** (the CLAUDE.md zip recipe omits it — see the deploy-zip-recipe memory). Build `--platform linux/amd64`.
3. **Build + deploy the hook image** — Phase C changes `credential-provider.ts`, which runs on the hook hot path. Redeploy `judge-ai-dredd-prod-hook` too.
4. **Verify versions:** `curl -sk https://dredd.acta.io/api/health` and `…/dredd-hook.acta.io/api/health` show the new version.
5. **Hot-path BYOT:** shared-token resolution only activates when `DREDD_BYOT_ENABLED=true` on the hook task. Storage + admin CRUD + redemption work regardless. Flip the flag once the write path has soaked.
6. **Smoke:** generate an invite from the dashboard, open the link in a private window, redeem, install the bundle on a test machine, confirm a judged session appears under the email-sub owner.

---

## Self-Review

**Spec coverage:**
- Synthetic identity + reconciliation → A1, D1. ✅
- `jaid-invites` table + store + single-use/TTL → A3, A4, A10. ✅
- Shared/pooled token + reference record → A2, A5, A6. ✅
- One-hop resolution, fail-soft, `DREDD_BYOT_ENABLED` gating → C1 + rollout step 5. ✅
- Pre-keyed bundle → B1. ✅
- Admin generate/list/revoke + shared-token CRUD endpoints + UI → A9, A11. ✅
- Fragment transport, GET-peek / POST-consume, redemption page → B3, B4. ✅
- Atomic redeem ordering (lock → mint → reference → stamp → bundle) → B2. ✅
- Security: hashed token, generic failures, rate limit, conditional single-use → A3/A4 (hash+conditional), B3 (rate limit + generic copy). ✅
- Default 1h expiry, admin-settable → A3 (default), A9 (clamp 0.25–24h). ✅

**Placeholder scan:** No TBD/TODO. The one deferred cross-reference (`invite-page.js` imported in B3, created in B4) is called out explicitly with ordering guidance. All code steps carry real code.

**Type consistency:** `InviteRecord`/`CreateInviteInput`/`StampResultInput` consistent across A3→A4→A7→B2. `SharedTokenRecord`/`SharedTokenView` consistent A2→A5→A6→A9. `writeReference(ownerSub, poolId)` and `refId`/`getShared` consistent A6→C1. `buildIntegrationBundle(dreddUrl, apiKey?)` consistent B1→B2. `ownerSubsForPrincipal` consistent A1→D1.

**Known follow-up to confirm during execution:** verify `ProbeResult.ok` and the `probeRegionCapabilities` signature in `src/byot/capability-probe.ts` (A6 stub depends on it), and the exact `renderReadme` template location in `integration-bundle.ts` (B1 splice).
