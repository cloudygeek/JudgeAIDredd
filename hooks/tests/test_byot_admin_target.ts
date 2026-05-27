// hooks/tests/test_byot_admin_target.ts
// Run: npx tsx hooks/tests/test_byot_admin_target.ts
import { resolveByotTarget, isKnownKeyOwner } from "../../src/byot/admin-target.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

async function main() {
  // Non-admin: requested ownerSub is ignored, always self.
  const a = resolveByotTarget({ isAdmin: false, selfSub: "me", requestedSub: "victim" });
  ok("non-admin locked to self", a.targetOwner === "me" && a.actingOnBehalf === false);

  // Admin targeting another user.
  const b = resolveByotTarget({ isAdmin: true, selfSub: "admin", requestedSub: "u1" });
  ok("admin targets requested user", b.targetOwner === "u1" && b.actingOnBehalf === true);

  // Admin with no requested sub → self, not acting on behalf.
  const d = resolveByotTarget({ isAdmin: true, selfSub: "admin", requestedSub: null });
  ok("admin with no target is self", d.targetOwner === "admin" && d.actingOnBehalf === false);

  // Admin requesting their own sub → self (no stamp).
  const e = resolveByotTarget({ isAdmin: true, selfSub: "admin", requestedSub: "admin" });
  ok("admin targeting self is not on-behalf", e.targetOwner === "admin" && e.actingOnBehalf === false);

  // Blank/whitespace requested sub → self.
  const f = resolveByotTarget({ isAdmin: true, selfSub: "admin", requestedSub: "   " });
  ok("blank requested sub falls back to self", f.targetOwner === "admin" && f.actingOnBehalf === false);

  // Known-owner guard against a fake apiKeys store.
  const fakeKeys = {
    async listByOwner(sub: string, _limit?: number) {
      return sub === "known" ? [{ ownerSub: "known" } as any] : [];
    },
  };
  ok("isKnownKeyOwner true for a key owner", (await isKnownKeyOwner(fakeKeys, "known")) === true);
  ok("isKnownKeyOwner false for unknown sub", (await isKnownKeyOwner(fakeKeys, "ghost")) === false);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
