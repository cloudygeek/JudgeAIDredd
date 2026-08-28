/**
 * Health-payload redaction (2026-08-28) — unauthenticated callers must
 * not learn the judge model, backend, or pipeline thresholds from
 * /health and /api/health; a valid Bearer key restores the full payload.
 *
 * Drives the pure `redactHealthPayload` (both shapes) plus
 * `requestHasValidApiKey`'s no-token path. No HTTP server.
 *
 * Run: npx tsx hooks/tests/test_health_redaction.ts
 */

process.env.DREDD_AUTH_MODE = "required";
process.env.STORE_BACKEND = "memory";
process.env.EMBEDDING_MODEL = "nomic-embed-text";
process.env.OLLAMA_HOST = "http://127.0.0.1:9";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

async function main() {
  const { redactHealthPayload, requestHasValidApiKey } = await import("../../src/server-core.js");

  const parts = {
    version: "0.1.999",
    role: "hook",
    config: {
      mode: "interactive",
      judgeModel: "qwen3.6:35b-coding",
      judgeBackend: "ollama",
      embeddingModel: "nomic-embed-text",
      reviewThreshold: 0.6,
      denyThreshold: 0.15,
      hijackThreshold: 2,
    },
    judge: { status: "degraded", model: "qwen3.6:35b-coding", totalCalls: 100, lastError: "x" },
    activeSessions: 3,
    uptimeSeconds: 42,
    intentMode: "history-active",
    intentClassifierLlmEnabled: true,
  };

  // =======================================================================
  section("Minimal (unauthenticated) shape hides the tuning surface");
  {
    const p: any = redactHealthPayload(false, parts as any);
    const flat = JSON.stringify(p);
    !flat.includes("qwen3.6") ? pass("judge model absent") : fail(`model leaked: ${flat}`);
    !flat.includes("denyThreshold") && !flat.includes("0.15")
      ? pass("thresholds absent") : fail("thresholds leaked");
    !flat.includes("ollama") ? pass("backend absent") : fail("backend leaked");
    !flat.includes("lastError") ? pass("judge internals absent") : fail("judge internals leaked");
    p.version === "0.1.999" ? pass("version kept (badge)") : fail(`version=${p.version}`);
    p.config?.mode === "interactive" && Object.keys(p.config).length === 1
      ? pass("config reduced to exactly {mode} (badge)") : fail(`config=${JSON.stringify(p.config)}`);
    p.activeSessions === 3 ? pass("activeSessions kept (badge)") : fail("activeSessions missing");
    p.judge?.status === "degraded" && Object.keys(p.judge).length === 1
      ? pass("judge reduced to exactly {status} (monitoring)") : fail(`judge=${JSON.stringify(p.judge)}`);
    p.degraded === true ? pass("degraded computed") : fail(`degraded=${p.degraded}`);
    p.uptimeSeconds === 42 ? pass("uptime kept") : fail("uptime missing");
  }
  {
    const p: any = redactHealthPayload(false, { ...parts, uptimeSeconds: undefined } as any);
    !("uptimeSeconds" in p) ? pass("uptime omitted when caller has none (/health shape)") : fail("stray uptime");
    const q: any = redactHealthPayload(false, { ...parts, judge: {} } as any);
    q.judge?.status === "unknown" ? pass("empty judge → status unknown") : fail(`judge=${JSON.stringify(q.judge)}`);
    q.degraded === false ? pass("unknown judge is not degraded") : fail("unknown counted degraded");
  }

  // =======================================================================
  section("Full (authenticated) shape unchanged");
  {
    const p: any = redactHealthPayload(true, parts as any);
    p.config?.judgeModel === "qwen3.6:35b-coding" ? pass("full config present") : fail("config trimmed");
    p.judge?.totalCalls === 100 ? pass("full judge present") : fail("judge trimmed");
    p.intentMode === "history-active" ? pass("intentMode present") : fail("intentMode missing");
    p.degraded === true && p.status === "ok" ? pass("status/degraded computed identically") : fail("status shape drifted");
  }

  // =======================================================================
  section("requestHasValidApiKey never writes, fails closed without a token");
  {
    const req: any = { headers: {} };
    (await requestHasValidApiKey(req)) === false
      ? pass("no Authorization header → false (minimal payload)")
      : fail("keyless request treated as trusted");
    const req2: any = { headers: { authorization: "Bearer jaid_live_not_a_real_key" } };
    (await requestHasValidApiKey(req2)) === false
      ? pass("invalid key → false")
      : fail("invalid key treated as trusted");
  }

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
