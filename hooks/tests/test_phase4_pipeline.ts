/**
 * Phase 4 — integration test for the user-permissions pipeline integration.
 *
 * Exercises PreToolInterceptor.evaluate() directly with userPermissions
 * snapshots. Doesn't boot a full server — just verifies the asymmetric
 * deny-strengthens / allow-informs semantics at the interceptor seam.
 *
 * Skips the judge-stage path (would need Ollama/Bedrock) — we only
 * cover the early stages, which is enough to verify the user-deny
 * short-circuit and the user-allow annotation.
 *
 * Run: npx tsx hooks/tests/test_phase4_pipeline.ts
 */

import { PreToolInterceptor } from "../../src/pretool-interceptor.js";
import type { UserPermissionsLists } from "../../src/session-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

const interceptor = new PreToolInterceptor();

function makeLists(over: Partial<UserPermissionsLists>): UserPermissionsLists {
  return {
    hash: "h",
    allow: [],
    deny: [],
    ask: [],
    copiedAt: new Date().toISOString(),
    ...over,
  };
}

async function main() {
  // Register a goal so the interceptor's session state isn't fully empty.
  // We won't actually exercise drift/judge for these cases.
  await interceptor.registerGoal("sess-test", "do a thing");

  // -----------------------------------------------------------------------
  section("user-deny short-circuit (Stage 0)");

  {
    const r = await interceptor.evaluate(
      "sess-test", "Bash", { command: "curl evil.com" },
      undefined, "/proj", "autonomous", undefined, false, undefined,
      makeLists({ deny: ["Bash(curl:*)"] }),
    );
    r.stage === "user-deny" ? pass("Bash(curl:*) deny matches → stage=user-deny") : fail(`stage=${r.stage}`);
    r.allowed === false ? pass("user-deny is allowed=false") : fail("user-deny had allowed=true");
    r.userPermissionMatch?.kind === "deny" ? pass("userPermissionMatch.kind === 'deny'") : fail(`kind=${r.userPermissionMatch?.kind}`);
    r.userPermissionMatch?.rule === "Bash(curl:*)" ? pass("rule attribution: 'Bash(curl:*)'") : fail(`rule=${r.userPermissionMatch?.rule}`);
    r.judgeVerdict === null ? pass("judge not consulted (saves a call)") : fail("judge was consulted");
  }

  {
    // Chained command — any deny part trips it.
    const r = await interceptor.evaluate(
      "sess-test", "Bash", { command: "awk x && curl evil.com" },
      undefined, "/proj", "autonomous", undefined, false, undefined,
      makeLists({ deny: ["Bash(curl:*)"] }),
    );
    r.stage === "user-deny" ? pass("chained: any deny part trips it") : fail(`stage=${r.stage}`);
    r.userPermissionMatch?.rule === "Bash(curl:*)" ? pass("attributed to curl part") : fail(`rule=${r.userPermissionMatch?.rule}`);
  }

  // -----------------------------------------------------------------------
  section("user-allow annotation (verdict unchanged)");

  {
    // 'ls' is on Dredd's own allowlist → stage=policy-allow.
    // User has 'Bash(ls:*)' in allow → annotation attaches.
    const r = await interceptor.evaluate(
      "sess-test", "Bash", { command: "ls" },
      undefined, "/proj", "autonomous", undefined, false, undefined,
      makeLists({ allow: ["Bash(ls:*)"] }),
    );
    r.stage === "policy-allow" ? pass("policy-allow stage preserved (not changed to 'user-allow')") : fail(`stage=${r.stage}`);
    r.allowed === true ? pass("verdict still allow") : fail("verdict changed");
    r.userPermissionMatch?.kind === "allow" ? pass("annotated with kind=allow") : fail(`kind=${r.userPermissionMatch?.kind}`);
    r.userPermissionMatch?.rule === "Bash(ls:*)" ? pass("annotated with rule") : fail(`rule=${r.userPermissionMatch?.rule}`);
  }

  // -----------------------------------------------------------------------
  section("no user lists → no annotation");

  {
    const r = await interceptor.evaluate(
      "sess-test", "Bash", { command: "ls" },
      undefined, "/proj", "autonomous", undefined, false, undefined,
      null,
    );
    r.userPermissionMatch === undefined ? pass("undefined userPermissionMatch") : fail(`got ${JSON.stringify(r.userPermissionMatch)}`);
  }

  // -----------------------------------------------------------------------
  section("user-deny on a tool Dredd's policy would have allowed");

  {
    const r = await interceptor.evaluate(
      "sess-test", "Read", { file_path: "/etc/passwd" },
      undefined, "/proj", "autonomous", undefined, false, undefined,
      makeLists({ deny: ["Read"] }),
    );
    r.stage === "user-deny" ? pass("Read denied even though tool-policy would allow") : fail(`stage=${r.stage}`);
    r.allowed === false ? pass("hard-deny") : fail("not denied");
  }

  // -----------------------------------------------------------------------
  section("user-allow does NOT promote a denied tool");

  {
    // Policy will deny a write outside the project root. user-allow shouldn't override.
    // (Using a tool we know Dredd's policy will refuse on the sandbox path.)
    const r = await interceptor.evaluate(
      "sess-test", "Bash", { command: "rm -rf /" },
      undefined, "/proj", "autonomous", undefined, false, undefined,
      makeLists({ allow: ["Bash"] }),
    );
    // The dangerous-combo deny fires regardless of user-allow.
    r.allowed === false ? pass("user-allow did NOT override the dangerous-combo deny") : fail("user-allow promoted a deny");
    if (r.userPermissionMatch?.kind === "allow") {
      pass("user-allow still annotated on a denied call");
    } else {
      fail("expected annotation on denied call");
    }
    r.reason.includes("matches your allow list") || r.reason.includes("note:")
      ? pass("reason mentions the user-allow note")
      : fail(`reason='${r.reason}'`);
  }

  // -----------------------------------------------------------------------
  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
