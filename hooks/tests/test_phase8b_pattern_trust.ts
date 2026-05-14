/**
 * Phase 8b — Stage 0.5 pattern-trust integration test.
 *
 * Exercises the interceptor's similarity matching by:
 *   1. Spinning a stub /api/embed HTTP server (Ollama-compatible).
 *   2. Pointing OLLAMA_HOST at it BEFORE any module loads ollama-client.
 *   3. Constructing ApprovalRecords with planted inputEmbedding vectors.
 *   4. Calling interceptor.evaluate with patternTrustHard true/false and
 *      asserting the right short-circuit / soft-context behavior.
 *
 * The judge stage is NOT exercised here (no Bedrock/Ollama for it).
 * We only need the Stage 0.5 outcomes, which manifest before the judge.
 *
 * Run: npx tsx hooks/tests/test_phase8b_pattern_trust.ts
 */

// ESM hoists imports above any top-level statements, so we cannot set
// OLLAMA_HOST at the top of the file and import ollama-client below —
// the import runs first, ollama-client reads OLLAMA_HOST as undefined,
// captures the localhost:11434 default. Workaround: set the env var
// before any dynamic import, do every interceptor-related import inside
// main() via `await import(…)`.
const STUB_PORT = 17215;
process.env.OLLAMA_HOST = `http://127.0.0.1:${STUB_PORT}`;

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PreToolInterceptor as PreToolInterceptorT } from "../../src/pretool-interceptor.js";
import type { ApprovalRecord } from "../../src/approval-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

// Map of canonical input substrings → deterministic 8-dim vectors.
// Test plants approvals with vector A; sends a call whose input
// contains the substring that maps to A2 (very similar to A).
const ALIGNED = [1, 0, 0, 0, 0, 0, 0, 0];
const ALMOST  = [0.98, 0.19, 0, 0, 0, 0, 0, 0];  // cosine ≈ 0.98 to ALIGNED
const FARISH  = [0.3, 0.95, 0, 0, 0, 0, 0, 0];   // cosine ≈ 0.3 to ALIGNED
const ORTHO   = [0, 1, 0, 0, 0, 0, 0, 0];        // cosine 0 to ALIGNED

function pickVecForInput(text: string): number[] {
  if (text.includes("ALIGNED")) return ALIGNED;
  if (text.includes("ALMOST")) return ALMOST;
  if (text.includes("FARISH")) return FARISH;
  if (text.includes("ORTHO")) return ORTHO;
  return ORTHO;
}

function startStub(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          const inputs: string[] = Array.isArray(parsed.input)
            ? parsed.input
            : [String(parsed.input ?? "")];
          const embeddings = inputs.map(pickVecForInput);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embeddings, model: parsed.model ?? "stub" }));
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => {
      resolve({ close: () => srv.close() });
    });
  });
}

function makeApproval(over: Partial<ApprovalRecord>): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    fingerprintHash: `fp-${Math.random().toString(36).slice(2, 8)}`,
    summary: "rm -rf node_modules",
    fingerprintJson: '{"command":"rm -rf node_modules"}',
    tool: "Bash",
    ownerSub: "user-a",
    ownerEmail: null,
    projectRoot: "/proj/foo",
    grantedAt: now,
    lastUsedAt: now,
    useCount: 1,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    intentSnapshot: "clean install",
    goalEmbedding: [],
    inputEmbedding: ALIGNED,
    revokedAt: null,
    revokedBy: null,
    ...over,
  };
}

async function main() {
  const stub = await startStub();
  // Dynamic import AFTER stub is up + env var was set above the
  // top-level imports.
  const { PreToolInterceptor } = await import("../../src/pretool-interceptor.js");
  try {
    const interceptor: PreToolInterceptorT = new PreToolInterceptor({
      // Non-bedrock model name so ollama-client routes to our stub.
      embeddingModel: "stub-test-model",
      // Don't matter for these tests since we never reach the judge.
      enableJudge: false,
    });
    await interceptor.registerGoal("s-test", "do a thing");

    // -------------------------------------------------------------------
    section("HARD short-circuit when ≥ 2 matches above HARD_THRESHOLD");

    {
      const approvals = [
        makeApproval({ summary: "approved rm 1", inputEmbedding: ALIGNED }),
        makeApproval({ summary: "approved rm 2", inputEmbedding: ALMOST }),
      ];
      const result = await interceptor.evaluate(
        "s-test",
        "Bash",
        { command: "ALIGNED rm -rf /something" },  // stub maps ALIGNED-containing input → ALIGNED vec
        undefined,
        "/proj/foo",
        "interactive",
        undefined,
        false,
        undefined,
        null,
        approvals,
        true,  // patternTrustHard
      );
      result.stage === "pattern-trust-allow" ? pass("stage = pattern-trust-allow") : fail(`stage=${result.stage}`);
      result.allowed === true ? pass("allowed=true") : fail("allowed=false");
      result.patternTrust?.hard === true ? pass("patternTrust.hard=true") : fail(`hard=${result.patternTrust?.hard}`);
      (result.patternTrust?.matched ?? 0) >= 2 ? pass(`matched=${result.patternTrust?.matched}`) : fail(`matched=${result.patternTrust?.matched}`);
    }

    // -------------------------------------------------------------------
    section("HARD disabled: same approvals, no short-circuit");

    {
      const approvals = [
        makeApproval({ summary: "approved rm 1", inputEmbedding: ALIGNED }),
        makeApproval({ summary: "approved rm 2", inputEmbedding: ALMOST }),
      ];
      const result = await interceptor.evaluate(
        "s-test",
        "Bash",
        { command: "ALIGNED something" },
        undefined,
        "/proj/foo",
        "interactive",
        undefined,
        false,
        undefined,
        null,
        approvals,
        false,  // patternTrustHard = false
      );
      result.stage !== "pattern-trust-allow"
        ? pass(`hard disabled: did NOT short-circuit (stage=${result.stage})`)
        : fail("short-circuited despite hard=false");
    }

    // -------------------------------------------------------------------
    section("Only 1 strong match: no short-circuit even with hard on");

    {
      const approvals = [
        makeApproval({ summary: "approved rm 1", inputEmbedding: ALIGNED }),
        // Second one too dissimilar to count
        makeApproval({ summary: "approved unrelated", inputEmbedding: ORTHO }),
      ];
      const result = await interceptor.evaluate(
        "s-test",
        "Bash",
        { command: "ALIGNED rm -rf x" },
        undefined,
        "/proj/foo",
        "interactive",
        undefined,
        false,
        undefined,
        null,
        approvals,
        true,
      );
      result.stage !== "pattern-trust-allow"
        ? pass(`1 strong + 1 weak: no short-circuit (stage=${result.stage})`)
        : fail("short-circuited with only 1 strong match");
    }

    // -------------------------------------------------------------------
    section("No matches: pipeline runs normally");

    {
      const approvals = [makeApproval({ inputEmbedding: ALIGNED })];
      const result = await interceptor.evaluate(
        "s-test",
        "Bash",
        { command: "ORTHO something completely different" },
        undefined,
        "/proj/foo",
        "interactive",
        undefined,
        false,
        undefined,
        null,
        approvals,
        true,
      );
      result.stage !== "pattern-trust-allow" ? pass(`no match: stage=${result.stage}`) : fail("unexpected short-circuit");
      result.patternTrust === undefined ? pass("no patternTrust annotation") : fail(`patternTrust=${JSON.stringify(result.patternTrust)}`);
    }

    // -------------------------------------------------------------------
    section("Empty priorApprovals: pipeline runs without embedding call");

    {
      const result = await interceptor.evaluate(
        "s-test",
        "Bash",
        { command: "ALIGNED whatever" },
        undefined,
        "/proj/foo",
        "interactive",
        undefined,
        false,
        undefined,
        null,
        [],
        true,
      );
      result.patternTrust === undefined ? pass("no patternTrust when priorApprovals empty") : fail("annotated");
    }

    // -------------------------------------------------------------------
    section("Approvals without inputEmbedding ([]): skipped silently");

    {
      const approvals = [makeApproval({ inputEmbedding: [] as number[] })];
      const result = await interceptor.evaluate(
        "s-test",
        "Bash",
        { command: "ALIGNED foo" },
        undefined,
        "/proj/foo",
        "interactive",
        undefined,
        false,
        undefined,
        null,
        approvals,
        true,
      );
      result.patternTrust === undefined ? pass("[]-vector approvals ignored") : fail("[]-vector counted somehow");
    }

  } finally {
    stub.close();
  }

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
