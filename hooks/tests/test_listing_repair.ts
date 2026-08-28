/**
 * META listing-key self-heal (2026-08-28) — sessions whose FIRST server
 * contact is /evaluate must still appear in the GSI-backed dashboard
 * listing.
 *
 * The bug (found live): putMeta is the only writer of
 * gsi1pk/gsi1sk/startedAt and only runs when META doesn't exist; a bare
 * aggregate ADD from recordToolCall upserts a KEYLESS META first, after
 * which the session is invisible to /api/sessions forever — while being
 * fully tracked (561 judged calls on the live instance).
 *
 * Drives the real DynamoSessionStore against a fake DocumentClient that
 * evaluates the store's actual UpdateExpression grammar (ADD, SET,
 * if_not_exists, the OCC version increment), so these tests fail if the
 * expressions regress OR if the fake diverges from what the store emits.
 *
 * Run: npx tsx hooks/tests/test_listing_repair.ts
 */

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

// ---------------------------------------------------------------------------
// Fake DocumentClient — evaluates the expression grammar the store emits.
// ---------------------------------------------------------------------------
class FakeDoc {
  items = new Map<string, Record<string, any>>();
  private k(pkv: string, skv: string) { return `${pkv}|${skv}`; }
  get(pkv: string, skv: string) { return this.items.get(this.k(pkv, skv)); }

  private resolveName(token: string, names: Record<string, string>): string {
    return token.startsWith("#") ? names[token] : token;
  }

  private checkCondition(cond: string | undefined, item: Record<string, any> | undefined, names: Record<string, string>, values: Record<string, any>): boolean {
    if (!cond) return true;
    // Grammar actually used by the store:
    //   attribute_not_exists(pk) / attribute_not_exists(sk)
    //   attribute_not_exists(#version) OR #version = :expectedVersion
    if (/^attribute_not_exists\((pk|sk)\)$/.test(cond.trim())) return item === undefined;
    const occ = /^attribute_not_exists\((\S+)\)\s+OR\s+(\S+)\s*=\s*(:\S+)$/.exec(cond.trim());
    if (occ) {
      const attr = this.resolveName(occ[1], names);
      if (item === undefined || item[attr] === undefined) return true;
      return item[this.resolveName(occ[2], names)] === values[occ[3]];
    }
    throw new Error(`FakeDoc: unhandled ConditionExpression: ${cond}`);
  }

  private applyUpdate(expr: string, item: Record<string, any>, names: Record<string, string>, values: Record<string, any>): void {
    // Split into ADD / SET sections (either order, either optional).
    const addM = /ADD\s+(.+?)(?=\s+SET\s+|$)/s.exec(expr);
    const setM = /SET\s+(.+?)(?=\s+ADD\s+|$)/s.exec(expr);
    if (addM) {
      for (const part of addM[1].split(",")) {
        const m = /^\s*(\S+)\s+(:\S+)\s*$/.exec(part);
        if (!m) throw new Error(`FakeDoc: bad ADD part: ${part}`);
        const attr = this.resolveName(m[1], names);
        item[attr] = (item[attr] ?? 0) + values[m[2]];
      }
    }
    if (setM) {
      // Split on commas not inside parens.
      const parts = setM[1].split(/,(?![^(]*\))/);
      for (const part of parts) {
        const assign = /^\s*(\S+)\s*=\s*(.+?)\s*$/s.exec(part);
        if (!assign) throw new Error(`FakeDoc: bad SET part: ${part}`);
        const attr = this.resolveName(assign[1], names);
        item[attr] = this.evalRhs(assign[2], item, names, values);
      }
    }
    if (!addM && !setM) throw new Error(`FakeDoc: unhandled UpdateExpression: ${expr}`);
  }

  private evalRhs(rhs: string, item: Record<string, any>, names: Record<string, string>, values: Record<string, any>): any {
    // if_not_exists(attr, :v) [+ :inc]
    const ine = /^if_not_exists\(\s*(\S+)\s*,\s*(:\S+)\s*\)\s*(?:\+\s*(:\S+))?$/.exec(rhs);
    if (ine) {
      const attr = this.resolveName(ine[1], names);
      const base = item[attr] !== undefined ? item[attr] : values[ine[2]];
      return ine[3] ? base + values[ine[3]] : base;
    }
    if (rhs.startsWith(":")) return values[rhs];
    throw new Error(`FakeDoc: unhandled SET rhs: ${rhs}`);
  }

  async send(cmd: any): Promise<any> {
    const name: string = cmd?.constructor?.name ?? "";
    const input = cmd?.input ?? {};
    if (name.startsWith("Get")) return { Item: this.get(input.Key.pk, input.Key.sk) };
    if (name.startsWith("Query")) return { Items: [], Count: 0 };
    if (name.startsWith("Put")) {
      const existing = this.get(input.Item.pk, input.Item.sk);
      if (!this.checkCondition(input.ConditionExpression, existing, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {})) {
        const err: any = new Error("conditional failed");
        err.name = "ConditionalCheckFailedException";
        Object.setPrototypeOf(err, (require("@aws-sdk/client-dynamodb") as any).ConditionalCheckFailedException?.prototype ?? Object.getPrototypeOf(err));
        throw err;
      }
      this.items.set(this.k(input.Item.pk, input.Item.sk), { ...input.Item });
      return {};
    }
    if (name.startsWith("Update")) {
      const key = this.k(input.Key.pk, input.Key.sk);
      const existing = this.items.get(key);
      if (!this.checkCondition(input.ConditionExpression, existing, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {})) {
        const err: any = new Error("conditional failed");
        err.name = "ConditionalCheckFailedException";
        Object.setPrototypeOf(err, (require("@aws-sdk/client-dynamodb") as any).ConditionalCheckFailedException?.prototype ?? Object.getPrototypeOf(err));
        throw err;
      }
      const item = existing ?? { pk: input.Key.pk, sk: input.Key.sk };
      this.applyUpdate(input.UpdateExpression, item, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {});
      this.items.set(key, item);
      return { Attributes: { ...item } };
    }
    throw new Error(`FakeDoc: unhandled command ${name}`);
  }
}

async function main() {
  const { DynamoSessionStore } = await import("../../src/dynamo-session-store.js");
  const META = (doc: FakeDoc, sid: string) => doc.get(`SESSION#${sid}`, "META");
  const KEYED = (m: any) =>
    m && m.gsi1pk === "SESSION" && typeof m.gsi1sk === "string" && typeof m.startedAt === "string";

  // =======================================================================
  section("agg-fold as FIRST write stamps listing keys (the live bug)");
  {
    const doc = new FakeDoc();
    const store = new DynamoSessionStore({ tableName: "t", client: doc as any });
    await store.recordToolCall("s-eval-first", "Bash", { command: "ls" }, "allow", 0.9, "toolu_1", { stage: "policy-allow" });
    const m = META(doc, "s-eval-first");
    KEYED(m) ? pass("META has gsi1pk/gsi1sk/startedAt after a pure recordToolCall") : fail(`META=${JSON.stringify(m)}`);
    m?.aggToolCalls === 1 ? pass("agg counter still counted") : fail(`agg=${m?.aggToolCalls}`);
    m?.sessionId === "s-eval-first" ? pass("sessionId stamped") : fail("sessionId missing");
  }

  // =======================================================================
  section("updateMeta upsert stamps listing keys");
  {
    const doc = new FakeDoc();
    const store = new DynamoSessionStore({ tableName: "t", client: doc as any });
    await store.recordClaudeMdScan("s-scan-first", { findings: [], summary: "clean" } as any);
    const m = META(doc, "s-scan-first");
    KEYED(m) ? pass("META keyed after updateMeta-only first write") : fail(`META=${JSON.stringify(m)}`);
  }

  // =======================================================================
  section("hijack-strike as first write stamps listing keys");
  {
    const doc = new FakeDoc();
    const store = new DynamoSessionStore({ tableName: "t", client: doc as any });
    await store.recordHijackStrike("s-strike-first", 2);
    const m = META(doc, "s-strike-first");
    KEYED(m) ? pass("META keyed after hijack-strike first write") : fail(`META=${JSON.stringify(m)}`);
  }

  // =======================================================================
  section("existing keys always win (if_not_exists contract)");
  {
    const doc = new FakeDoc();
    const store = new DynamoSessionStore({ tableName: "t", client: doc as any });
    await store.setProjectRoot("s-normal", "/proj"); // putMeta path — true start
    const before = META(doc, "s-normal");
    const t0 = before?.startedAt;
    t0 && before?.gsi1sk === t0 ? pass("putMeta stamped true start") : fail("putMeta baseline broken");
    await new Promise((r) => setTimeout(r, 5));
    await store.recordToolCall("s-normal", "Bash", { command: "ls" }, "allow", 0.9, "toolu_2", {});
    await store.recordHijackStrike("s-normal", 99);
    const after = META(doc, "s-normal");
    after?.startedAt === t0 && after?.gsi1sk === t0
      ? pass("later writes never overwrite startedAt/gsi1sk")
      : fail(`start drifted: ${t0} → ${after?.startedAt}/${after?.gsi1sk}`);
  }

  // =======================================================================
  section("legacy keyless META heals on next write");
  {
    const doc = new FakeDoc();
    // Seed a pre-fix broken row: aggs but no keys (what the live bug left).
    doc.items.set("SESSION#s-legacy|META", { pk: "SESSION#s-legacy", sk: "META", aggToolCalls: 561, aggDenied: 17 });
    const store = new DynamoSessionStore({ tableName: "t", client: doc as any });
    await store.recordToolCall("s-legacy", "Bash", { command: "ls" }, "allow", 0.9, "toolu_3", {});
    const m = META(doc, "s-legacy");
    KEYED(m) ? pass("broken row healed by one ordinary write") : fail(`META=${JSON.stringify(m)}`);
    m?.aggToolCalls === 562 ? pass("existing aggregates preserved (561→562)") : fail(`agg=${m?.aggToolCalls}`);
  }

  // =======================================================================
  section("lastActivityAt refreshes on every judged call");
  {
    const doc = new FakeDoc();
    const store = new DynamoSessionStore({ tableName: "t", client: doc as any });
    await store.recordToolCall("s-act", "Bash", { command: "a" }, "allow", 0.9, "toolu_a1", {});
    const t1 = META(doc, "s-act")?.lastActivityAt;
    t1 ? pass("stamped on first call") : fail("missing after first call");
    await new Promise((r) => setTimeout(r, 5));
    await store.recordToolCall("s-act", "Bash", { command: "b" }, "allow", 0.9, "toolu_a2", {});
    const t2 = META(doc, "s-act")?.lastActivityAt;
    t2 && t2 > t1 ? pass("REFRESHED on the next call (plain SET, not if_not_exists)") : fail(`t1=${t1} t2=${t2}`);
  }

  // =======================================================================
  section("sessionIsLive: activity-based liveness");
  {
    const { sessionIsLive, STALE_SESSION_MS } = await import("../../src/server-dashboard.js");
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    sessionIsLive({ endedAt: null, lastActivityAt: iso(60_000) }, now)
      ? pass("recent activity → live") : fail("recent marked stale");
    !sessionIsLive({ endedAt: iso(60_000), lastActivityAt: iso(30_000) }, now)
      ? pass("endedAt always wins → not live") : fail("ended shown live");
    !sessionIsLive({ endedAt: null, lastActivityAt: iso(STALE_SESSION_MS + 1000) }, now)
      ? pass("stale never-ended → folds out of live view") : fail("stale shown live");
    sessionIsLive({ endedAt: null, lastActivityAt: null, startedAt: iso(60_000) }, now)
      ? pass("pre-field row falls back to startedAt") : fail("startedAt fallback broken");
    !sessionIsLive({ endedAt: null, lastActivityAt: null, startedAt: null }, now)
      ? pass("no timestamps at all → not live") : fail("timestampless shown live");
  }

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
