/**
 * `applyIntentStackUpdate` must not be able to 500 `POST /intent`.
 *
 * THE GAP
 * -------
 * /intent now routes registerIntent through `registerIntentOrDegrade`
 * (handlers/intent.ts) so a DynamoDB failure degrades instead of 500-ing.
 * `applyIntentStackUpdate` runs AFTER that and is still unprotected: any
 * store failure inside it still fails the request.
 *
 * WHY IT MATTERS BEYOND TIDINESS
 * ------------------------------
 * A failed /intent means the turn's goal never registers, so /evaluate
 * judges every later tool call against a stale goal. That surfaces to the
 * user as spurious approval prompts. Non-fatal /intent is a false-positive
 * fix, not just a reliability one.
 *
 * WHAT THE RIGHT DEGRADED STATE IS
 * --------------------------------
 * Silently swallowing would be its own hazard. applyIntentStackUpdate makes
 * SEVERAL store writes (markIntentResolved / activateIntent /
 * setActiveIntents), so a mid-sequence failure can leave the persisted
 * active set MISSING the user's newest goal — entries marked resolved, the
 * replacement stack never written. The judge then anchors on whatever
 * survived: an older goal, or (if the set emptied) the session's turn-1
 * prompt. That is exactly the spurious-approval failure mode.
 *
 * So the degraded result must be loud AND actionable: it reports
 * `degraded: true` and refuses to impersonate a real classification, and
 * the handler uses that to re-anchor the interceptor on the user's current
 * prompt — the same "keep the judge anchored" bargain registerIntentOrDegrade
 * already strikes.
 *
 * Run: npx tsx hooks/tests/test_intent_stack_degrade.ts
 * Exits non-zero on any failure.
 */

const STUB_PORT = 45872;
process.env.OLLAMA_HOST = `http://127.0.0.1:${STUB_PORT}`;

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { SessionStore } from "../../src/session-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const ok = (cond: boolean, m: string) => (cond ? pass(m) : fail(m));
const eq = <T>(a: T, b: T, m: string) =>
  a === b ? pass(m) : fail(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

function startStub(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const inputs: string[] = Array.isArray(parsed.input)
          ? parsed.input
          : [String(parsed.input ?? parsed.prompt ?? "")];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: inputs.map((t) => [t.length % 7, 1, 0.5]), model: "stub" }));
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve({ close: () => srv.close() }));
  });
}

/** Capture console.error/warn/log for the duration of `fn`. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const real = { error: console.error, warn: console.warn, log: console.log };
  const cap = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = cap; console.warn = cap; console.log = cap;
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = real.error; console.warn = real.warn; console.log = real.log;
  }
}

const TIMINGS_CLOSED = { prevUserPromptAt: 100, prevPreToolUseAt: 100, prevStopAt: 200 };
const TIMINGS_DRAINING = { prevUserPromptAt: 100, prevPreToolUseAt: 300, prevStopAt: 200 };

/**
 * A store stub that works normally until the named method, which throws.
 * `failAt: null` = never fails. Only the handful of methods
 * applyIntentStackUpdate touches are implemented.
 */
function makeStore(failAt: string | null, opts: { existing?: any[] } = {}): {
  store: SessionStore;
  calls: string[];
} {
  const calls: string[] = [];
  let active: any[] = opts.existing ?? [];
  const boom = (name: string) => {
    const e = new Error(`ProvisionedThroughputExceededException on ${name}`);
    e.name = "ProvisionedThroughputExceededException";
    throw e;
  };
  const guard = (name: string) => { calls.push(name); if (failAt === name) boom(name); };

  const store: any = {
    async getActiveIntents() { guard("getActiveIntents"); return active; },
    async getIntentHistory() { guard("getIntentHistory"); return active; },
    async getIntentLastActive() { guard("getIntentLastActive"); return {}; },
    async markIntentResolved(_s: string, ids: string[]) {
      guard("markIntentResolved");
      active = active.filter((e) => !ids.includes(e.id));
    },
    async activateIntent() { guard("activateIntent"); },
    async setActiveIntents(_s: string, stack: any[]) { guard("setActiveIntents"); active = stack; },
    async setEntryClassifierSource() { guard("setEntryClassifierSource"); },
  };
  return { store: store as SessionStore, calls };
}

const entry = (id: string, prompt: string) => ({
  id, prompt, contextual: prompt, embedding: [1, 0, 0.5],
  registeredAt: Date.now() - 1000, kind: "continuation", resolved: false,
});

/**
 * A stack already at MAX_ACTIVE_INTENTS (5). Adding one more forces LRU
 * eviction, which is what actually drives `markIntentResolved` — without
 * it that store method is never reached and a "fails at markIntentResolved"
 * case would pass vacuously.
 */
const FULL_STACK = Array.from({ length: 5 }, (_, i) => entry(`e${i}`, `goal number ${i}`));

// ---------------------------------------------------------------------------
async function main() {
  const stub = await startStub();
  try {
    const mod: any = await import("../../src/intent-stack.js");

    // =====================================================================
    section("the wrapper exists and mirrors registerIntentOrDegrade");

    const wrap = mod.applyIntentStackUpdateOrDegrade;
    ok(typeof wrap === "function", "applyIntentStackUpdateOrDegrade is exported from intent-stack");

    if (typeof wrap !== "function") {
      console.log(`\n${c.red}${FAIL} FAILED${c.off}  (${PASS} passed, ${FAIL} failed)\n`);
      process.exit(1);
    }

    // =====================================================================
    section("happy path is untouched");

    {
      const { store } = makeStore(null);
      const r = await wrap(store, "sess-ok", "add a regression test", null, false, TIMINGS_CLOSED, "stub-model");
      eq(r.degraded, false, "success → degraded false");
      eq(r.kind, "original", "success → the real classification passes through");
      eq(r.turnState, "closed", "success → the real turn state passes through");
      eq(r.stack.length, 1, "success → the real stack passes through");
      ok(typeof r.newEntryId === "string" && r.newEntryId.length > 0, "success → newEntryId passes through");
    }

    {
      // A second prompt on a live stack — exercises the classify + evict path.
      const { store } = makeStore(null, { existing: [entry("e1", "fix the deploy script")] });
      const r = await wrap(store, "sess-ok2", "now add a regression test", null, false, TIMINGS_DRAINING, "stub-model");
      eq(r.degraded, false, "success on a live stack → degraded false");
      eq(r.kind, "queued", "success on a live stack → draining classifies as queued");
      eq(r.stack.length, 2, "success on a live stack → the new entry is appended");
    }

    // =====================================================================
    section("a store failure degrades instead of throwing");

    // Every store method applyIntentStackUpdate can call, including the
    // ones that run AFTER a partial mutation.
    for (const failAt of [
      "getActiveIntents",
      "getIntentHistory",
      "getIntentLastActive",
      "markIntentResolved",
      "setActiveIntents",
    ]) {
      // FULL_STACK guarantees every one of these is genuinely reached —
      // markIntentResolved only fires once LRU eviction has something to evict.
      const { store, calls } = makeStore(failAt, { existing: [...FULL_STACK] });
      let threw: Error | null = null;
      let r: any;
      const { lines } = await captureLogs(async () => {
        try {
          r = await wrap(store, "sess-boom", "completely different topic now please", null, false, TIMINGS_CLOSED, "stub-model");
        } catch (err) { threw = err as Error; }
      });
      ok(calls.includes(failAt), `the ${failAt} failure point is actually reached (not a vacuous pass)`);
      ok(threw === null, `failure at ${failAt} does not propagate (${(threw as Error | null)?.message ?? "ok"})`);
      eq(r?.degraded, true, `failure at ${failAt} → degraded true`);
      ok(
        lines.some((l) => l.includes("ProvisionedThroughputExceededException")),
        `failure at ${failAt} is logged with the underlying cause`,
      );
      ok(
        lines.some((l) => l.includes("sess-boo")),
        `failure at ${failAt} is logged with the session prefix`,
      );
    }

    // =====================================================================
    section("the degraded result does not impersonate a real update");

    {
      const { store } = makeStore("setActiveIntents", { existing: [entry("e1", "fix the deploy script")] });
      let r: any;
      await captureLogs(async () => {
        r = await wrap(store, "sess-shape", "new goal", null, false, TIMINGS_DRAINING, "stub-model");
      });
      eq(r.degraded, true, "degraded flag set");
      eq(r.turnState, "draining", "turnState is still REAL — deriveTurnState is pure, no store needed");
      eq(r.stack.length, 0, "stack is empty, not a guess at what survived the partial write");
      eq(r.driftToStackTop, null, "drift is null (unknown), never 0 — 0 would read as 'perfectly on-goal'");
      eq(r.newEntryId, undefined, "no newEntryId — nothing durable to hang an LLM override on");
    }

    // =====================================================================
    section("the async LLM classifier must not run on a degraded update");
    // newEntryId is the handler's gate for spawning the Bedrock classifier.
    // Leaving it undefined is what stops a fire-and-forget override from
    // mutating an active set we already know is inconsistent.

    {
      const { store, calls } = makeStore("markIntentResolved", { existing: [...FULL_STACK] });
      let r: any;
      await captureLogs(async () => {
        r = await wrap(store, "sess-gate", "actually do something else instead", null, false, TIMINGS_CLOSED, "stub-model");
      });
      ok(calls.includes("markIntentResolved"), "the eviction write is reached");
      ok(r.degraded === true, "a failure during eviction still degrades");
      ok(r.newEntryId === undefined, "degraded → newEntryId undefined (classifier gate closed)");
    }

    // =====================================================================
    section("/intent is wired to the wrapper, and re-anchors when degraded");

    {
      const here = dirname(fileURLToPath(import.meta.url));
      const src = readFileSync(resolve(here, "../../src/handlers/intent.ts"), "utf8");

      ok(
        /applyIntentStackUpdateOrDegrade\s*\(/.test(src),
        "handlers/intent.ts calls applyIntentStackUpdateOrDegrade",
      );
      ok(
        !/(?<!OrDegrade)\bstackUpdate\s*=\s*await\s+applyIntentStackUpdate\s*\(/.test(src),
        "handlers/intent.ts no longer calls the bare applyIntentStackUpdate",
      );
      ok(
        /stackUpdate\.degraded/.test(src),
        "handlers/intent.ts branches on stackUpdate.degraded",
      );
      // The whole point: a degraded stack update must still leave the judge
      // anchored on the user's current prompt. Slice the branch body out
      // between its `if` and the `} else` that closes it.
      const open = src.indexOf("if (stackUpdate.degraded) {");
      ok(open >= 0, "the degraded branch is present");
      const close = open >= 0 ? src.indexOf("} else", open) : -1;
      const body = open >= 0 && close > open ? src.slice(open, close) : "";
      ok(body.length > 0, "the degraded branch has a body");
      ok(
        /interceptor\.registerGoal\s*\(/.test(body),
        "the degraded branch re-anchors the judge via interceptor.registerGoal",
      );
      ok(
        /contextualGoal/.test(body),
        "…on the CURRENT prompt's contextual goal, not a stale one",
      );
    }
  } finally {
    stub.close();
  }

  console.log(
    `\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off}  (${PASS} passed, ${FAIL} failed)\n`,
  );
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${c.red}HARNESS ERROR${c.off}: ${err?.stack ?? err}`);
  process.exit(1);
});
