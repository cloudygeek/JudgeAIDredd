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
