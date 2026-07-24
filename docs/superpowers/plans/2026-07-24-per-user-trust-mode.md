# Per-user Trust Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin mark a Clerk user as *trusted* from the dashboard so their tool calls skip the LLM judge (and drift embedding) to save Bedrock cost, while deterministic hard denies still enforce.

**Architecture:** A per-`ownerSub` trust flag stored as a `sk="TRUST"` item on the existing `jaid-byot` DynamoDB table (no new infra/IAM/KMS). `/evaluate` resolves the flag on the hot path (5-min in-process cache) and, when `DREDD_TRUST_MODE_ENABLED=true`, threads `trustedOwner` into the interceptor, which short-circuits to `trust-allow` after Stage 0 user-deny + Stage 1 policy but before Stage 2 drift + Stage 3 judge. Admin-only dashboard tab writes the flag.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 22, `@aws-sdk/lib-dynamodb`, `npx tsx` for tests, plain HTML/JS dashboard.

## Global Constraints

- ESM module resolution: **all relative imports use `.js` specifiers** even from `.ts` sources (e.g. `import { X } from "./trust-store.js"`).
- **Do NOT edit `package.json` `version`** — `.githooks/pre-commit` auto-bumps the patch on every commit.
- Tests run via `npx tsx hooks/tests/<file>.ts` and print `ALL PASS` / exit non-zero on failure; follow the `ok(msg, cond)` house style.
- Every commit message ends with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `STORE_BACKEND` defaults to `memory` (local dev uses `InMemory*` stores); `dynamo` in prod.
- Feature ships behind `DREDD_TRUST_MODE_ENABLED` (default `false`) — storage + UI work regardless; only the `/evaluate` short-circuit is gated.
- The current branch is `intent-history-active`; commit there (do not open a PR unless asked).

---

### Task 1: Trust storage + resolver

**Files:**
- Create: `src/trust-store.ts`
- Create: `src/dynamo-trust-store.ts`
- Create: `src/trust-resolver.ts`
- Test: `hooks/tests/test_trust_store.ts`

**Interfaces:**
- Produces:
  - `TrustRecord = { ownerSub: string; enabled: boolean; setBy: string; setByEmail: string | null; setAt: string; note?: string | null }`
  - `interface TrustStore { get(ownerSub): Promise<TrustRecord | null>; put(record): Promise<void>; delete(ownerSub): Promise<void> }`
  - `class InMemoryTrustStore implements TrustStore`
  - `class DynamoTrustStore implements TrustStore` with `constructor(opts: { tableName: string; region: string; client?: DynamoDBDocumentClient })`
  - `class TrustResolver` with `constructor(opts: { store: TrustStore; cacheTtlMs?: number; now?: () => number })`, `isTrusted(ownerSub: string | null | undefined): Promise<boolean>`, `invalidate(ownerSub: string): void`
  - `parseTrustToggle(body: any): { ok: true; value: { ownerSub: string; enabled: boolean; note: string | null } } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing test** — `hooks/tests/test_trust_store.ts`

```typescript
// hooks/tests/test_trust_store.ts
// Run: npx tsx hooks/tests/test_trust_store.ts
import { InMemoryTrustStore, parseTrustToggle } from "../../src/trust-store.js";
import { DynamoTrustStore } from "../../src/dynamo-trust-store.js";
import { TrustResolver } from "../../src/trust-resolver.js";
import type { TrustStore, TrustRecord } from "../../src/trust-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  // --- InMemoryTrustStore round-trip ---
  const store = new InMemoryTrustStore();
  ok("get on empty returns null", (await store.get("u1")) === null);
  await store.put({ ownerSub: "u1", enabled: true, setBy: "admin_1", setByEmail: "a@x.io", setAt: "t0", note: "trusted dev" });
  const r = await store.get("u1");
  ok("get returns stored record", r?.enabled === true && r?.setBy === "admin_1" && r?.note === "trusted dev");
  ok("scoped to ownerSub", (await store.get("u2")) === null);
  await store.delete("u1");
  ok("delete removes the row", (await store.get("u1")) === null);

  // --- DynamoTrustStore against a fake client ---
  const fakeTable = new Map<string, any>();
  const fakeClient = {
    async send(cmd: any): Promise<any> {
      const name = cmd.constructor.name;
      const key = (k: any) => `${k.pk}|${k.sk}`;
      if (name === "PutCommand") { fakeTable.set(key(cmd.input.Item), cmd.input.Item); return {}; }
      if (name === "GetCommand") { return { Item: fakeTable.get(key(cmd.input.Key)) }; }
      if (name === "DeleteCommand") { fakeTable.delete(key(cmd.input.Key)); return {}; }
      throw new Error("unexpected command " + name);
    },
  } as any;
  const dyn = new DynamoTrustStore({ tableName: "jaid-byot", region: "eu-west-1", client: fakeClient });
  await dyn.put({ ownerSub: "d1", enabled: true, setBy: "admin_2", setByEmail: null, setAt: "t0", note: null });
  const dr = await dyn.get("d1");
  ok("dynamo round-trips", dr?.enabled === true && dr?.setBy === "admin_2" && dr?.setByEmail === null && dr?.note === null);
  ok("dynamo item lands under sk=TRUST", fakeTable.has("USER#d1|TRUST"));
  await dyn.delete("d1");
  ok("dynamo delete", (await dyn.get("d1")) === null);

  // --- TrustResolver: enabled / disabled / missing ---
  const memStore = new InMemoryTrustStore();
  await memStore.put({ ownerSub: "on", enabled: true, setBy: "a", setByEmail: null, setAt: "t0" });
  await memStore.put({ ownerSub: "off", enabled: false, setBy: "a", setByEmail: null, setAt: "t0" });
  const resolver = new TrustResolver({ store: memStore });
  ok("isTrusted true for enabled row", (await resolver.isTrusted("on")) === true);
  ok("isTrusted false for enabled=false row", (await resolver.isTrusted("off")) === false);
  ok("isTrusted false for missing row", (await resolver.isTrusted("nope")) === false);
  ok("isTrusted false for null ownerSub", (await resolver.isTrusted(null)) === false);

  // --- TrustResolver caching (injected clock) ---
  let clock = 1000;
  const counting = new InMemoryTrustStore();
  await counting.put({ ownerSub: "c1", enabled: true, setBy: "a", setByEmail: null, setAt: "t0" });
  let getCalls = 0;
  const wrapped: TrustStore = {
    get: async (s) => { getCalls++; return counting.get(s); },
    put: (r) => counting.put(r), delete: (s) => counting.delete(s),
  };
  const cached = new TrustResolver({ store: wrapped, cacheTtlMs: 100, now: () => clock });
  await cached.isTrusted("c1");
  await cached.isTrusted("c1");
  ok("second call within TTL is cached (1 store hit)", getCalls === 1);
  clock += 200; // expire
  await cached.isTrusted("c1");
  ok("call after TTL re-reads store (2 store hits)", getCalls === 2);
  cached.invalidate("c1");
  await cached.isTrusted("c1");
  ok("invalidate forces re-read (3 store hits)", getCalls === 3);

  // --- TrustResolver fail-soft (store throws → false) ---
  const boom: TrustStore = {
    get: async () => { throw new Error("dynamo down"); },
    put: async () => {}, delete: async () => {},
  };
  const failSoft = new TrustResolver({ store: boom });
  ok("fail-soft returns false on store error", (await failSoft.isTrusted("x")) === false);

  // --- parseTrustToggle validation ---
  ok("parse rejects non-object", parseTrustToggle(null).ok === false);
  ok("parse rejects missing ownerSub", parseTrustToggle({ enabled: true }).ok === false);
  ok("parse rejects non-boolean enabled", parseTrustToggle({ ownerSub: "u", enabled: "yes" }).ok === false);
  const good = parseTrustToggle({ ownerSub: "  u1  ", enabled: true, note: "hi" });
  ok("parse accepts + trims ownerSub", good.ok === true && good.ok && good.value.ownerSub === "u1");
  const noNote = parseTrustToggle({ ownerSub: "u1", enabled: false });
  ok("parse defaults note to null", noNote.ok === true && noNote.ok && noNote.value.note === null);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_trust_store.ts`
Expected: FAIL — `Cannot find module '../../src/trust-store.js'` (modules not created yet).

- [ ] **Step 3: Create `src/trust-store.ts`**

```typescript
// src/trust-store.ts
/** Per-user "trust" flag: an admin-granted judge bypass. One row per
 *  ownerSub, stored as a sk=TRUST item on the jaid-byot table (see
 *  server-core.ts wiring). Holds no secret — plaintext boolean + audit
 *  metadata, so no KMS. */
export interface TrustRecord {
  ownerSub: string;
  enabled: boolean;
  /** Clerk userId of the admin who set it. */
  setBy: string;
  /** Admin's email if Clerk surfaced one. */
  setByEmail: string | null;
  /** ISO timestamp of the last change. */
  setAt: string;
  /** Free-text reason (optional). */
  note?: string | null;
}

export interface TrustStore {
  get(ownerSub: string): Promise<TrustRecord | null>;
  put(record: TrustRecord): Promise<void>;
  delete(ownerSub: string): Promise<void>;
}

export class InMemoryTrustStore implements TrustStore {
  private readonly rows = new Map<string, TrustRecord>();
  async get(ownerSub: string): Promise<TrustRecord | null> {
    return this.rows.get(ownerSub) ?? null;
  }
  async put(record: TrustRecord): Promise<void> {
    this.rows.set(record.ownerSub, { ...record });
  }
  async delete(ownerSub: string): Promise<void> {
    this.rows.delete(ownerSub);
  }
}

export type TrustToggleInput = { ownerSub: string; enabled: boolean; note: string | null };

/** Validate a POST /api/trust body. Pure — no I/O. */
export function parseTrustToggle(
  body: any,
): { ok: true; value: TrustToggleInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const ownerSub = typeof body.ownerSub === "string" ? body.ownerSub.trim() : "";
  if (!ownerSub) return { ok: false, error: "ownerSub is required" };
  if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  return { ok: true, value: { ownerSub, enabled: body.enabled, note } };
}
```

- [ ] **Step 4: Create `src/dynamo-trust-store.ts`**

```typescript
// src/dynamo-trust-store.ts
/**
 * DynamoDB-backed TrustStore. One row per ownerSub on the shared jaid-byot
 * table: pk = USER#<ownerSub>, sk = TRUST. No KMS (no secret stored).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { TrustStore, TrustRecord } from "./trust-store.js";

export interface DynamoTrustStoreOptions {
  tableName: string;
  region: string;
  /** Override for tests. */
  client?: DynamoDBDocumentClient;
}

const pk = (ownerSub: string) => `USER#${ownerSub}`;
const SK = "TRUST";

function itemToRecord(item: Record<string, any>): TrustRecord {
  return {
    ownerSub: item.ownerSub,
    enabled: !!item.enabled,
    setBy: item.setBy,
    setByEmail: item.setByEmail ?? null,
    setAt: item.setAt,
    note: item.note ?? null,
  };
}

export class DynamoTrustStore implements TrustStore {
  private readonly tableName: string;
  private readonly doc: DynamoDBDocumentClient;
  constructor(opts: DynamoTrustStoreOptions) {
    this.tableName = opts.tableName;
    this.doc = opts.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }), {
        marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
      });
  }
  async get(ownerSub: string): Promise<TrustRecord | null> {
    const out = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: pk(ownerSub), sk: SK },
    }));
    return out.Item ? itemToRecord(out.Item) : null;
  }
  async put(record: TrustRecord): Promise<void> {
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
}
```

- [ ] **Step 5: Create `src/trust-resolver.ts`**

```typescript
// src/trust-resolver.ts
import type { TrustStore } from "./trust-store.js";

interface CacheEntry { trusted: boolean; expiresAt: number; }

export interface TrustResolverOptions {
  store: TrustStore;
  /** Trusted-boolean cache TTL. Default 5 min. */
  cacheTtlMs?: number;
  /** Override for tests. */
  now?: () => number;
}

/** Resolves whether an owner is trusted on the hot path. Caches the boolean
 *  in-process so /evaluate doesn't hit Dynamo every call. Fails soft to
 *  `false` (not-trusted) on any store error — a trust outage costs a judge
 *  call, never an accidental allow-all. */
export class TrustResolver {
  private readonly store: TrustStore;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: TrustResolverOptions) {
    this.store = opts.store;
    this.ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  invalidate(ownerSub: string): void {
    this.cache.delete(ownerSub);
  }

  async isTrusted(ownerSub: string | null | undefined): Promise<boolean> {
    if (!ownerSub) return false;
    const cached = this.cache.get(ownerSub);
    if (cached && cached.expiresAt > this.now()) return cached.trusted;
    let trusted = false;
    try {
      const rec = await this.store.get(ownerSub);
      trusted = !!(rec && rec.enabled);
    } catch (err) {
      console.warn(`[trust] resolve failed for ${ownerSub.substring(0, 8)}: ${(err as Error)?.message ?? err}`);
      trusted = false;
    }
    this.cache.set(ownerSub, { trusted, expiresAt: this.now() + this.ttl });
    return trusted;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_trust_store.ts`
Expected: PASS — `ALL PASS (17/17)`.

- [ ] **Step 7: Commit**

```bash
git add src/trust-store.ts src/dynamo-trust-store.ts src/trust-resolver.ts hooks/tests/test_trust_store.ts
git commit -m "feat(trust): per-user trust store + resolver (sk=TRUST on jaid-byot)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Interceptor trust short-circuit

**Files:**
- Modify: `src/pretool-interceptor.ts` (stage union ~line 93; `evaluate` param list ~line 352; short-circuit insertion ~line 595)
- Test: `hooks/tests/test_trust_pipeline.ts`

**Interfaces:**
- Consumes: `PreToolInterceptor` from Task 0 (existing).
- Produces: `evaluate(...)` gains a final positional param `trustedOwner?: boolean`; `InterceptionResult.stage` gains `"trust-allow"`.

- [ ] **Step 1: Write the failing test** — `hooks/tests/test_trust_pipeline.ts`

```typescript
/**
 * Trust short-circuit integration test.
 *   - trustedOwner=true on a review-zone call → stage "trust-allow" (judge skipped).
 *   - trustedOwner=true on rm -rf → still policy-deny (hard guardrail preserved).
 *   - trustedOwner=false on the same review call → NOT trust-allow (gate works).
 * Run: npx tsx hooks/tests/test_trust_pipeline.ts
 */
const STUB_PORT = 17231;
process.env.OLLAMA_HOST = `http://127.0.0.1:${STUB_PORT}`;

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PreToolInterceptor as PreToolInterceptorT } from "../../src/pretool-interceptor.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

function startStub(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (ch) => (body += ch));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const inputs: string[] = Array.isArray(parsed.input) ? parsed.input : [String(parsed.input ?? "")];
        const embeddings = inputs.map(() => [0, 1, 0, 0, 0, 0, 0, 0]); // constant vec; drift path is not under test
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings, model: parsed.model ?? "stub" }));
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve({ close: () => srv.close() }));
  });
}

// Positional evaluate() args up to the new trustedOwner (17th).
function callEvaluate(interceptor: PreToolInterceptorT, tool: string, input: Record<string, unknown>, trustedOwner: boolean) {
  return interceptor.evaluate(
    "s-trust", tool, input,
    undefined,            // fileContext
    "/proj/foo",          // projectRoot
    "autonomous",         // mode
    undefined,            // activeIntents
    false,                // historyActiveJudgeRendering
    undefined,            // approvalCheck
    null,                 // userPermissions
    undefined,            // priorApprovals
    false,                // patternTrustHard
    undefined,            // bedrockAuth
    undefined,            // taintEvidence
    undefined,            // cwd
    undefined,            // instructionsEvidence
    trustedOwner,         // trustedOwner (NEW)
  );
}

async function main() {
  const stub = await startStub();
  const { PreToolInterceptor } = await import("../../src/pretool-interceptor.js");
  try {
    const interceptor: PreToolInterceptorT = new PreToolInterceptor({
      embeddingModel: "stub-test-model",
      enableJudge: false,
    });
    await interceptor.registerGoal("s-trust", "do a thing");

    // 1. Trusted owner + review-zone command → trust-allow (before drift/judge).
    const t = await callEvaluate(interceptor, "Bash", { command: "frobnicate --xyz" }, true);
    ok("trusted review call → stage trust-allow", t.stage === "trust-allow");
    ok("trusted review call → allowed", t.allowed === true);
    ok("trusted review call → no judge verdict", t.judgeVerdict === null);

    // 2. Trusted owner + rm -rf → still denied by policy (guardrail preserved).
    const d = await callEvaluate(interceptor, "Bash", { command: "rm -rf /etc" }, true);
    ok("trusted rm -rf → NOT allowed", d.allowed === false);
    ok("trusted rm -rf → policy-deny stage", d.stage === "policy-deny");

    // 3. Not trusted + same review command → NOT trust-allow (gate works).
    const n = await callEvaluate(interceptor, "Bash", { command: "frobnicate --xyz" }, false);
    ok("untrusted review call → NOT trust-allow", n.stage !== "trust-allow");

    console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  } finally {
    stub.close();
  }
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx hooks/tests/test_trust_pipeline.ts`
Expected: FAIL — `trusted review call → stage trust-allow` fails (evaluate ignores the 17th arg; the call falls through to drift → `drift-allow`).

- [ ] **Step 3: Add `"trust-allow"` to the stage union** — `src/pretool-interceptor.ts` ~line 93

Change:
```typescript
    | "user-deny"
    | "pattern-trust-allow";
```
to:
```typescript
    | "user-deny"
    | "pattern-trust-allow"
    | "trust-allow";
```

- [ ] **Step 4: Add the `trustedOwner` parameter** — `src/pretool-interceptor.ts` ~line 352

Change the tail of the `evaluate` signature from:
```typescript
    instructionsEvidence?: string,
  ): Promise<InterceptionResult> {
```
to:
```typescript
    instructionsEvidence?: string,
    /** Per-user trust short-circuit. When true, allow at Stage 1.9 (after
     *  Stage 0 user-deny + Stage 1 policy, before Stage 2 drift + Stage 3
     *  judge) — skips the judge AND the drift embedding. Set by /evaluate
     *  from the jaid-byot sk=TRUST flag when DREDD_TRUST_MODE_ENABLED. Never
     *  overrides a hard deny: those return before this point. */
    trustedOwner?: boolean,
  ): Promise<InterceptionResult> {
```

- [ ] **Step 5: Insert the short-circuit** — `src/pretool-interceptor.ts`, between the approval-lookup block and the `// --- Stage 2: Embedding drift check ---` comment (~line 595)

Insert immediately BEFORE the `// --- Stage 2: Embedding drift check ---` line:
```typescript
    // --- Stage 1.9: Owner-trust short-circuit --------------------------
    // A trusted owner (admin-granted, resolved on the hot path) skips the
    // LLM judge AND the drift embedding to save cost. Deliberately placed
    // AFTER Stage 0 user-deny and Stage 1 policy so hard denies (rm -rf,
    // dangerous combinations, user-deny) still block — trust bypasses only
    // the judgement stages, never the deterministic guardrails. Unlike
    // pattern-trust-hard it does NOT override policy denies.
    if (trustedOwner) {
      const result: InterceptionResult = {
        allowed: true,
        tool,
        input,
        stage: "trust-allow",
        policyResult,
        similarity: null,
        judgeVerdict: null,
        evaluationMs: Date.now() - start,
        reason: "Owner is trusted — LLM judge skipped",
      };
      this.log(s, result, sessionId, userAllowMatch);
      return result;
    }

```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx hooks/tests/test_trust_pipeline.ts`
Expected: PASS — `ALL PASS (6/6)`.

- [ ] **Step 7: Guard against regressions** — run the existing pipeline + pattern-trust tests

Run: `npx tsx hooks/tests/test_phase4_pipeline.ts && npx tsx hooks/tests/test_phase8b_pattern_trust.ts`
Expected: both `ALL PASS` (the new optional param defaults undefined → falsy → no behavior change for existing callers).

- [ ] **Step 8: Commit**

```bash
git add src/pretool-interceptor.ts hooks/tests/test_trust_pipeline.ts
git commit -m "feat(trust): interceptor trust-allow short-circuit before drift+judge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the flag + thread `trustedOwner` through `/evaluate`

**Files:**
- Modify: `src/server-core.ts` (imports near top; new export block after the BYOT block ~line 708)
- Modify: `src/handlers/evaluate.ts` (import block lines 29–38; before the `interceptor.evaluate(` call ~line 492)

**Interfaces:**
- Consumes: `TrustStore`, `InMemoryTrustStore`, `parseTrustToggle` (Task 1), `DynamoTrustStore` (Task 1), `TrustResolver` (Task 1); `evaluate(..., trustedOwner)` (Task 2).
- Produces: `server-core.ts` exports `TRUST_MODE_ENABLED: boolean`, `trustStore: TrustStore`, `trustResolver: TrustResolver`.

- [ ] **Step 1: Add imports to `src/server-core.ts`** (with the other store imports near the top of the file, alongside the existing `byot-store` / `dynamo-byot-store` imports)

```typescript
import { type TrustStore, InMemoryTrustStore } from "./trust-store.js";
import { DynamoTrustStore } from "./dynamo-trust-store.js";
import { TrustResolver } from "./trust-resolver.js";
```

- [ ] **Step 2: Add the wiring block** — `src/server-core.ts`, immediately AFTER the BYOT block (after the `export const byotService = new ByotService({...})` / `USER_PERMISSIONS_ENFORCED` region, ~line 708)

```typescript
// ---------------------------------------------------------------------------
// Trust mode — per-user admin-granted judge bypass. Stored as a sk=TRUST item
// on the SAME jaid-byot table (no new infra/IAM/KMS). TRUST_MODE_ENABLED gates
// ONLY the /evaluate hot-path short-circuit; the dashboard write path + storage
// work regardless so the feature can soak before enforcement.
// ---------------------------------------------------------------------------
export const TRUST_MODE_ENABLED =
  (process.env.DREDD_TRUST_MODE_ENABLED ?? "false").toLowerCase() === "true";

export const trustStore: TrustStore = STORE_BACKEND === "dynamo"
  ? new DynamoTrustStore({ tableName: DYNAMO_BYOT_TABLE_NAME, region: DYNAMO_REGION })
  : new InMemoryTrustStore();

export const trustResolver = new TrustResolver({ store: trustStore });

console.log(
  `  [TRUST] Judge-bypass: ${TRUST_MODE_ENABLED ? "ENABLED" : "disabled (rollout)"} ` +
    `(store=${STORE_BACKEND}, table=${DYNAMO_BYOT_TABLE_NAME})`,
);
```

- [ ] **Step 3: Add imports to `src/handlers/evaluate.ts`** — extend the existing `from "../server-core.js"` block (lines 29–38)

Add these two names to that import block (next to `USER_PERMISSIONS_ENFORCED`, `PATTERN_LEARNING_HARD`, `credentialProvider`):
```typescript
  TRUST_MODE_ENABLED,
  trustResolver,
```

- [ ] **Step 4: Resolve + thread `trustedOwner`** — `src/handlers/evaluate.ts`, immediately BEFORE the `const result = await interceptor.evaluate(` call (~line 492)

Insert:
```typescript
  // Per-user trust: an admin can mark this owner trusted so their calls skip
  // the judge (+ drift embedding). Gated on DREDD_TRUST_MODE_ENABLED; the
  // resolver caches per-owner for 5 min and fails soft to "not trusted", so a
  // trust-store blip just means a judge call, never an accidental allow-all.
  const trustedOwner = TRUST_MODE_ENABLED
    ? await trustResolver.isTrusted(ownerForApproval.ownerSub)
    : false;
  if (trustedOwner) {
    console.log(`  [${session_id.substring(0, 8)}] [TRUST] owner trusted — judge bypassed`);
  }
```

Then add `trustedOwner` as the final argument of the `interceptor.evaluate(...)` call. Change the call's tail from:
```typescript
    cwdForEval,
    instructionsEvidence,
  );
```
to:
```typescript
    cwdForEval,
    instructionsEvidence,
    trustedOwner,
  );
```

- [ ] **Step 5: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: exits 0, no errors.

- [ ] **Step 6: Re-run the trust + pipeline tests (nothing regressed)**

Run: `npx tsx hooks/tests/test_trust_store.ts && npx tsx hooks/tests/test_trust_pipeline.ts && npx tsx hooks/tests/test_phase4_pipeline.ts`
Expected: all three `ALL PASS`.

- [ ] **Step 7: Commit**

```bash
git add src/server-core.ts src/handlers/evaluate.ts
git commit -m "feat(trust): wire DREDD_TRUST_MODE_ENABLED + thread trustedOwner into /evaluate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Dashboard API — `GET/POST/DELETE /api/trust` (admin-only)

**Files:**
- Modify: `src/server-dashboard.ts` (import block lines ~37–55; new route handler after the `/api/byot` block ~line 576)

**Interfaces:**
- Consumes: `trustStore` (Task 3), `parseTrustToggle` (Task 1), existing `requireClerkAuth`, `readBody`, `json`, `isKnownKeyOwner`, `apiKeys`.
- Produces: HTTP route `/api/trust` (admin-only). GET → `{ ownerSub, enabled, setBy?, setByEmail?, setAt?, note? }`; POST `{ ownerSub, enabled, note? }` → same status shape; DELETE `?ownerSub=` → `{ ownerSub, enabled: false }`.

- [ ] **Step 1: Add imports** — `src/server-dashboard.ts`

Add `trustStore` to the `from "./server-core.js"` import block (next to `byotService`):
```typescript
  trustStore,
```
Add a new import (near the `resolveByotTarget` import ~line 55):
```typescript
import { parseTrustToggle } from "./trust-store.js";
```

- [ ] **Step 2: Add the route handler** — `src/server-dashboard.ts`, immediately AFTER the `/api/byot` block closes (after its `return json(res, 405, ...)` / closing `}` ~line 576) and BEFORE the `/api/approvals` block

```typescript
    // ---------------------------------------------------------------
    // Trust mode — per-user admin-granted judge bypass. ADMIN ONLY.
    // GET status, POST toggle (enabled:true upserts, false deletes),
    // DELETE removes. Stored as sk=TRUST on jaid-byot via trustStore.
    // ---------------------------------------------------------------
    if (url.pathname === "/api/trust") {
      const principal = await requireClerkAuth(req, res);
      if (!principal) return;
      if (!principal.isAdmin) return json(res, 403, { error: "Admin only" });

      const statusFor = async (ownerSub: string) => {
        const rec = await trustStore.get(ownerSub);
        return rec
          ? { ownerSub, enabled: rec.enabled, setBy: rec.setBy, setByEmail: rec.setByEmail, setAt: rec.setAt, note: rec.note ?? null }
          : { ownerSub, enabled: false };
      };

      if (req.method === "GET") {
        const ownerSub = url.searchParams.get("ownerSub");
        if (!ownerSub) return json(res, 400, { error: "ownerSub is required" });
        return json(res, 200, await statusFor(ownerSub));
      }

      if (req.method === "POST") {
        let body: any;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: "Invalid JSON body" });
        }
        const parsed = parseTrustToggle(body);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        const { ownerSub, enabled, note } = parsed.value;
        if (!(await isKnownKeyOwner(apiKeys, ownerSub))) {
          return json(res, 404, { error: "Unknown user" });
        }
        if (enabled) {
          await trustStore.put({
            ownerSub,
            enabled: true,
            setBy: principal.userId,
            setByEmail: principal.email || null,
            setAt: new Date().toISOString(),
            note,
          });
        } else {
          await trustStore.delete(ownerSub);
        }
        return json(res, 200, await statusFor(ownerSub));
      }

      if (req.method === "DELETE") {
        const ownerSub = url.searchParams.get("ownerSub");
        if (!ownerSub) return json(res, 400, { error: "ownerSub is required" });
        await trustStore.delete(ownerSub);
        return json(res, 200, { ownerSub, enabled: false });
      }

      return json(res, 405, { error: "Method not allowed" });
    }
```

> Note: the dashboard writes the flag; the hook container's `TrustResolver` picks up the change within its 5-min cache TTL. The dashboard does not (and need not) touch the resolver — they run in separate containers.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 4: Manual smoke (documented — requires a Clerk admin JWT)**

Run the dashboard locally and exercise the route. In one shell:
```bash
STORE_BACKEND=memory DREDD_ROLE=dashboard CLERK_SECRET_KEY=sk_test_xxx PORT=3011 npm run server >/tmp/dash.log 2>&1 &
```
Then, with `TOKEN` set to a valid Clerk **admin** session JWT (grab from the dashboard's network tab after signing in):
```bash
# Non-admin / no token → 401/403 (auth enforced server-side)
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3011/api/trust?ownerSub=user_x"   # expect 401
# Admin GET on an unset user → { enabled: false }
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3011/api/trust?ownerSub=<known_ownerSub>"
# Admin enable (ownerSub must own an API key, else 404)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ownerSub":"<known_ownerSub>","enabled":true,"note":"dev box"}' "http://127.0.0.1:3011/api/trust"
# Admin disable
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ownerSub":"<known_ownerSub>","enabled":false}' "http://127.0.0.1:3011/api/trust"
```
Expected: 401 without a token; `{ "ownerSub": …, "enabled": true, "setBy": …, "setAt": … }` on enable; `{ "enabled": false }` on disable. Kill the server: `kill %1`.

- [ ] **Step 5: Commit**

```bash
git add src/server-dashboard.ts
git commit -m "feat(trust): admin-only GET/POST/DELETE /api/trust on dashboard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Dashboard UI — admin-only Trust tab

**Files:**
- Modify: `src/web/dashboard.html` (tab bar ~line 369; new tab-content after `#tab-byot` closes ~line 836; `KNOWN_TABS` ~line 2453; non-admin guard ~line 2458; `switchTab` dispatch ~line 2483; new JS functions after the BYOT JS block ~line 2900)

**Interfaces:**
- Consumes: `GET/POST /api/trust` (Task 4); existing `dreddFetch`, `API`, `esc`, `dreddPrincipal`, `.admin-only` CSS (hides for `body[data-role="user"]`).

- [ ] **Step 1: Add the tab button** — after the BYOT tab (~line 369)

```html
      <div class="tab admin-only" onclick="switchTab('trust')">Trust</div>
```

- [ ] **Step 2: Add the tab content** — after the `#tab-byot` `</div>` closes (~line 836), before the `<!-- DETAIL PAGE -->` comment

```html
    <div id="tab-trust" class="tab-content admin-only">
      <div style="max-width:620px">
        <h2 style="margin:0 0 4px">Trust mode — skip the judge for a user</h2>
        <p class="muted" style="margin:0 0 16px;font-size:13px">
          Mark a user as trusted so their tool calls skip the LLM judge (and the
          drift embedding) to save Bedrock cost. Deterministic guardrails
          (<span class="mono">rm -rf</span>, dangerous combinations, and the
          user's own deny list) still block. Applies to every project the user
          runs. Enforced only when <span class="mono">DREDD_TRUST_MODE_ENABLED</span>
          is set on the hook container.
        </p>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:4px">User</label>
          <select id="trust-user" onchange="renderTrust()"
                  style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:13px;font-family:inherit;width:100%">
            <option value="">— select a user —</option>
          </select>
        </div>
        <div id="trust-status" style="margin-bottom:16px"></div>
        <div id="trust-form" style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;display:none">
          <div style="margin-bottom:12px">
            <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:4px">Note (optional)</label>
            <input type="text" id="trust-note" autocomplete="off" placeholder="why this user is trusted"
                   style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:13px;font-family:inherit">
          </div>
          <div style="display:flex;gap:12px;align-items:center">
            <button class="refresh-btn" id="trust-enable" onclick="setTrust(true)" style="font-size:14px">Enable trust</button>
            <button class="refresh-btn" id="trust-disable" onclick="setTrust(false)" style="font-size:14px;border:1px solid var(--red);color:var(--red)">Disable</button>
            <span id="trust-msg" style="font-size:13px;color:var(--muted)"></span>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12px">
            ⚠︎ Enabling disables the LLM judge for this user in every project.
          </p>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: Register the tab in `KNOWN_TABS` + guard** — ~line 2453

Change:
```javascript
    const KNOWN_TABS = ['overview', 'policies', 'logs', 'integrate', 'keys', 'approvals', 'byot'];
```
to:
```javascript
    const KNOWN_TABS = ['overview', 'policies', 'logs', 'integrate', 'keys', 'approvals', 'byot', 'trust'];
```
And immediately after the existing `if (tab === 'logs' && !(dreddPrincipal && dreddPrincipal.isAdmin)) return 'overview';` line (~line 2458), add:
```javascript
      if (tab === 'trust' && !(dreddPrincipal && dreddPrincipal.isAdmin)) return 'overview';
```

- [ ] **Step 4: Dispatch load on tab switch** — ~line 2483, next to `if (tab === 'byot') loadByot();`

Add:
```javascript
      if (tab === 'trust') loadTrust();
```

- [ ] **Step 5: Add the JS functions** — after the BYOT JS block (after `saveAdminByot()` / `removeAdminByot()`, ~line 2900)

```javascript
    // ---- Trust tab (admin only) ------------------------------------------
    async function loadTrust() {
      if (!(dreddPrincipal && dreddPrincipal.isAdmin)) return;
      await loadTrustUserList();
      renderTrust();
    }

    async function loadTrustUserList() {
      const sel = document.getElementById('trust-user');
      if (!sel) return;
      try {
        const r = await dreddFetch(`${API}/api/keys`);
        if (!r.ok) return;
        const keys = await r.json();
        const seen = new Set();
        const users = [];
        for (const k of keys) {
          if (!k.ownerSub || seen.has(k.ownerSub)) continue;
          seen.add(k.ownerSub);
          users.push({ ownerSub: k.ownerSub, email: k.ownerEmail || '' });
        }
        users.sort((a, b) => (a.email || a.ownerSub).localeCompare(b.email || b.ownerSub));
        sel.innerHTML = '<option value="">— select a user —</option>' +
          users.map(u => `<option value="${esc(u.ownerSub)}">${esc(u.email || '(no email)')} — ${esc(u.ownerSub.slice(0, 12))}…</option>`).join('');
      } catch (e) { /* leave list as-is on error */ }
    }

    async function renderTrust() {
      const sub = document.getElementById('trust-user').value;
      const statusEl = document.getElementById('trust-status');
      const formEl = document.getElementById('trust-form');
      const msgEl = document.getElementById('trust-msg');
      if (msgEl) msgEl.textContent = '';
      if (!sub) { statusEl.innerHTML = ''; formEl.style.display = 'none'; return; }
      formEl.style.display = 'block';
      try {
        const r = await dreddFetch(`${API}/api/trust?ownerSub=${encodeURIComponent(sub)}`);
        if (!r.ok) { statusEl.innerHTML = `<div style="color:var(--red);font-size:13px">Failed to load (HTTP ${r.status})</div>`; return; }
        const s = await r.json();
        if (s.enabled) {
          statusEl.innerHTML = `<div style="background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden">
            <table style="margin:0">
              <tr><td style="width:140px;color:var(--muted)">Trust</td><td style="color:var(--green);font-weight:600">ENABLED — judge skipped</td></tr>
              <tr><td style="color:var(--muted)">Set by</td><td class="muted">${esc(s.setByEmail || s.setBy || '—')}${s.setAt ? ' on ' + esc(new Date(s.setAt).toLocaleString()) : ''}</td></tr>
              ${s.note ? `<tr><td style="color:var(--muted)">Note</td><td class="muted">${esc(s.note)}</td></tr>` : ''}
            </table></div>`;
        } else {
          statusEl.innerHTML = `<div style="font-size:13px;color:var(--muted);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px">Not trusted — this user's calls go through the judge.</div>`;
        }
      } catch (e) {
        statusEl.innerHTML = `<div style="color:var(--red);font-size:13px">Failed: ${esc(e.message)}</div>`;
      }
    }

    async function setTrust(enabled) {
      const sub = document.getElementById('trust-user').value;
      const note = document.getElementById('trust-note').value.trim();
      const msgEl = document.getElementById('trust-msg');
      if (!sub) { msgEl.style.color = 'var(--red)'; msgEl.textContent = 'Select a user first.'; return; }
      msgEl.style.color = 'var(--muted)';
      msgEl.textContent = enabled ? 'Enabling…' : 'Disabling…';
      try {
        const r = await dreddFetch(`${API}/api/trust`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ownerSub: sub, enabled, note: note || null }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          msgEl.style.color = 'var(--red)';
          msgEl.textContent = e.error || `Failed (HTTP ${r.status})`;
          return;
        }
        msgEl.style.color = 'var(--green)';
        msgEl.textContent = enabled ? 'Trust enabled.' : 'Trust disabled.';
        renderTrust();
      } catch (e) {
        msgEl.style.color = 'var(--red)';
        msgEl.textContent = 'Failed: ' + (e && e.message ? e.message : e);
      }
    }
```

- [ ] **Step 6: Manual verification (dashboard is not TS — no tsc)**

Start the dashboard (`STORE_BACKEND=memory DREDD_ROLE=dashboard CLERK_SECRET_KEY=sk_test_xxx PORT=3011 npm run server`), open `http://127.0.0.1:3011`, sign in as an admin. Verify:
- A **Trust** tab appears in the tab bar (and is absent when signed in as a non-admin — confirm the `admin-only` class hides it: `document.body.getAttribute('data-role')` is `user`).
- Selecting a user shows current status; **Enable trust** flips it to ENABLED with your email + timestamp; **Disable** clears it.
- Reload the page, reselect the user → status persists (in-memory for this local run).

- [ ] **Step 7: Commit**

```bash
git add src/web/dashboard.html
git commit -m "feat(trust): admin-only Trust tab in the dashboard UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Docs — CLAUDE.md + full-suite green

**Files:**
- Modify: `CLAUDE.md` (env-var table; a new feature subsection; Key files table; Test surface list)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add the env-var row** — `CLAUDE.md`, in the "Environment variables" table, after the `DREDD_INSTRUCTIONS_EVIDENCE_ENABLED` row

```markdown
| `DREDD_TRUST_MODE_ENABLED` | `false` | When `true`, `/evaluate` resolves a per-user trust flag (admin-set via the dashboard, stored as `sk="TRUST"` on `jaid-byot`) and, for a trusted owner, short-circuits to `stage="trust-allow"` after Stage 0 user-deny + Stage 1 policy but BEFORE Stage 2 drift + Stage 3 judge — skipping the LLM judge (and drift embedding) to save cost. Deterministic hard denies (`rm -rf`, dangerous combos, user-deny) still block. Resolver caches per-owner 5 min, fails soft to not-trusted. Storage + dashboard write path work regardless of the flag; only the hot-path short-circuit is gated. Default off; flip on after soak |
```

- [ ] **Step 2: Add a feature subsection** — `CLAUDE.md`, under "User permissions — Claude Code allow/deny/ask integration" add a new numbered subsection (after "### 6. Instruction-load judge evidence")

```markdown
### 7. Trust mode — per-user admin-granted judge bypass

Lets an admin mark a Clerk user (`ownerSub`) as **trusted** so their tool calls
skip the LLM judge (and drift embedding) to save Bedrock cost, while the
deterministic guardrails still enforce.

- **Storage:** a `sk="TRUST"` item on the existing **`jaid-byot`** table
  (`pk = USER#<ownerSub>`) — no new table/IAM/KMS (trust records hold no secret).
  `src/trust-store.ts` (`TrustStore` + `InMemoryTrustStore` + `parseTrustToggle`),
  `src/dynamo-trust-store.ts` (`DynamoTrustStore`).
- **Hot-path resolver:** `src/trust-resolver.ts` `TrustResolver.isTrusted(ownerSub)`
  with a 5-min in-process cache; fails soft to not-trusted.
- **Wiring:** `/evaluate` (gated on `DREDD_TRUST_MODE_ENABLED`) resolves the flag
  for the session owner and threads `trustedOwner` into `interceptor.evaluate`,
  which short-circuits to `stage="trust-allow"` after Stage 0 user-deny + Stage 1
  policy, before Stage 2 drift + Stage 3 judge. Unlike `pattern-trust-hard`, it
  does **not** override hard denies (it sits after them). The decision is still
  recorded via `/track` (stage `trust-allow` shows in the feed + Tool Calls).
- **Dashboard:** admin-only **Trust** tab → `GET/POST/DELETE /api/trust`
  (`isAdmin`-enforced server-side). Cross-container: the dashboard writes the
  flag; the hook picks it up within the resolver's 5-min TTL.
- **Admin-only, soft-rollout:** storage + UI work with the flag off; only the
  `/evaluate` short-circuit is gated.
```

- [ ] **Step 3: Add Key files rows** — `CLAUDE.md`, "Key files" table

```markdown
| `src/trust-store.ts` | `TrustStore` + `InMemoryTrustStore` + `parseTrustToggle` — per-user judge-bypass flag |
| `src/dynamo-trust-store.ts` | `DynamoTrustStore` against `jaid-byot` (`pk=USER#<ownerSub>`, `sk=TRUST`) |
| `src/trust-resolver.ts` | `TrustResolver.isTrusted` — hot-path trust lookup with 5-min cache, fail-soft |
```

- [ ] **Step 4: Add the tests to the Test surface list** — `CLAUDE.md`, in the "### Test surface" code block

```
hooks/tests/test_trust_store.ts                     # TrustStore + resolver + parseTrustToggle           (17, npx tsx)
hooks/tests/test_trust_pipeline.ts                  # interceptor trust-allow short-circuit + ordering    (6, npx tsx)
```

- [ ] **Step 5: Run the full trust test surface + typecheck once more**

Run:
```bash
npx tsc --noEmit && npx tsx hooks/tests/test_trust_store.ts && npx tsx hooks/tests/test_trust_pipeline.ts
```
Expected: tsc exits 0; both suites `ALL PASS`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(trust): document per-user trust mode (env, feature, key files, tests)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deployment note (not a task)

The feature is **inert in prod until deployed AND flag-flipped**. Per CLAUDE.md, running containers don't pick up `src/` changes until a new image is built and the ECS service is redeployed. Rollout order once merged:
1. Build + deploy the **dashboard** image (Trust tab + `/api/trust`) — storage/UI can be exercised with `DREDD_TRUST_MODE_ENABLED` still off.
2. Build + deploy the **hook** image (resolver + `/evaluate` threading) with `DREDD_TRUST_MODE_ENABLED=false` first (soak: the resolver isn't even consulted).
3. Enable a user via the Trust tab, then flip `DREDD_TRUST_MODE_ENABLED=true` on the hook task def and redeploy. Verify `trust-allow` appears on that user's Tool Calls.

## Self-review notes

- **Spec coverage:** semantics (Task 2), per-user `ownerSub` storage on `jaid-byot` (Tasks 1, 3), admin-only toggle (Tasks 4, 5), fail-closed (Task 1 resolver), flag gate (Task 3), still-recorded (unchanged `recordToolCall` in evaluate.ts, noted in Task 3/§7 docs), API (Task 4), UI (Task 5), rollout (Task 6 + deployment note) — all covered.
- **Surfacing nuance:** the spec mentioned a `trust` chip "like pattern-trust"; MVP surfaces the `trust-allow` **stage** in the existing feed + Tool Calls stage column (already rendered). A dedicated colored chip is deferred polish (YAGNI), consistent with the spec's out-of-scope framing.
- **Type consistency:** `TrustRecord`, `TrustStore`, `parseTrustToggle`, `TrustResolver.isTrusted`, `trustedOwner`, stage `"trust-allow"` used identically across all tasks.
