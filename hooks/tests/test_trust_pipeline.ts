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
