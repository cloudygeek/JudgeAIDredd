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
