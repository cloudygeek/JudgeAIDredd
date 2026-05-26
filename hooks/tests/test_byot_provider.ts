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
  const priorDecryptCalls = decryptCalls;
  await bearer.resolve("u1");
  ok("invalidate forces a fresh decrypt", decryptCalls === priorDecryptCalls + 1);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
