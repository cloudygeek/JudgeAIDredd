/**
 * Decision capture (plan-consent-completion phase 1) — the PermissionDenied
 * path end to end at the store and handler layers.
 *
 * Store semantics (InMemorySessionStore.recordUserDeny): a refusal paired
 * by toolUseId decorates the PreToolUse decision row with a "user-denied"
 * outcome; unpaired refusals append a standalone row with decision="deny"
 * (the call never ran — unlike the failure path's "allow"); reason capped.
 *
 * Handler semantics (handleTrack, flag ON in the parent process): a
 * user_decision="deny" body records the refusal and consumes the pending
 * approval WITHOUT promoting it — a refusal must never become an
 * ApprovalRecord. Approval promotions get decision labels when the flag
 * is on. Flag OFF is re-checked in a CHILD process (env is read at module
 * load): the deny branch must be a complete no-op.
 *
 * No HTTP server, no Ollama, no Bedrock. Auth is disabled via
 * DREDD_AUTH_MODE=off set before the server-core import.
 *
 * Run: npx tsx hooks/tests/test_decision_capture.ts
 */

process.env.DREDD_AUTH_MODE = "off";
process.env.STORE_BACKEND = "memory";
if (process.env.DECISION_CAPTURE_CHILD !== "1") {
  process.env.DREDD_DECISION_CAPTURE_ENABLED = "true";
}
// The embed call in the promotion path must not hit a real backend: point
// OLLAMA at a dead port; the handler treats embed failure as best-effort.
process.env.OLLAMA_HOST = "http://127.0.0.1:9";
// Pin the embedding model to an Ollama name so no code path (promotion
// embed, intent embed) reaches for Bedrock credentials in this test.
process.env.EMBEDDING_MODEL = "nomic-embed-text";

import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

/** Minimal IncomingMessage/ServerResponse fakes for handleTrack. */
function fakeReq(body: unknown): any {
  const r: any = Readable.from([Buffer.from(JSON.stringify(body))]);
  r.headers = {};
  r.socket = { remoteAddress: "127.0.0.1" };
  return r;
}
function fakeRes(): { res: any; result: () => { status: number; body: any } } {
  let status = 0;
  let payload: any = null;
  const res: any = {
    writeHead(s: number) { status = s; },
    end(b?: string) { payload = b ? JSON.parse(b) : null; },
  };
  return { res, result: () => ({ status, body: payload }) };
}

async function main() {
  const { InMemorySessionStore } = await import("../../src/session-tracker.js");

  // =======================================================================
  section("Store: paired refusal decorates the decision row");
  {
    const store = new InMemorySessionStore();
    const sid = "s-deny-pair";
    await store.recordToolCall(sid, "Bash", { command: "curl x" }, "review", 0.4, "toolu_d1", { stage: "judge-ask" });
    await store.recordUserDeny(sid, "Bash", { command: "curl x" }, "toolu_d1", "user clicked No");

    const ctx = await store.getSessionContext(sid);
    ctx.recentTools.length === 1 ? pass("decorated, not duplicated") : fail(`rows=${ctx.recentTools.length}`);
    const row = ctx.recentTools[0];
    row?.outcome?.status === "user-denied" ? pass("outcome.status === 'user-denied'") : fail(`outcome=${JSON.stringify(row?.outcome)}`);
    row?.outcome?.error === "user clicked No" ? pass("denial reason captured") : fail(`error=${row?.outcome?.error}`);
    row?.decision === "review" ? pass("original decision preserved") : fail(`decision=${row?.decision}`);
    row?.stage === "judge-ask" ? pass("original stage preserved") : fail(`stage=${row?.stage}`);
  }

  // =======================================================================
  section("Store: unpaired refusal appends standalone deny row");
  {
    const store = new InMemorySessionStore();
    const sid = "s-deny-alone";
    await store.recordUserDeny(sid, "Bash", { command: "rm -rf x" }, "toolu_lost", "");

    const ctx = await store.getSessionContext(sid);
    ctx.recentTools.length === 1 ? pass("one standalone row") : fail(`rows=${ctx.recentTools.length}`);
    const row = ctx.recentTools[0];
    row?.decision === "deny" ? pass("standalone decision === 'deny' (the call never ran)") : fail(`decision=${row?.decision}`);
    row?.stage === "user-denied" ? pass("stage === 'user-denied'") : fail(`stage=${row?.stage}`);
    row?.outcome?.status === "user-denied" ? pass("outcome carried") : fail("outcome missing");
  }

  // =======================================================================
  section("Store: reason capped at 2000");
  {
    const store = new InMemorySessionStore();
    const sid = "s-deny-cap";
    await store.recordUserDeny(sid, "Bash", { command: "x" }, null, "R".repeat(5000));
    const ctx = await store.getSessionContext(sid);
    const len = ctx.recentTools[0]?.outcome?.error.length ?? 0;
    len === 2000 ? pass("reason capped to 2000") : fail(`len=${len}`);
  }

  // =======================================================================
  const flagOn = process.env.DECISION_CAPTURE_CHILD !== "1";
  const core = await import("../../src/server-core.js");
  const { handleTrack } = await import("../../src/handlers/track.js");
  const { recordPendingApproval, consumePendingApproval } = await import("../../src/pending-approvals.js");

  if (flagOn) {
    section("Handler (flag ON): deny records outcome + consumes pending WITHOUT promoting");
    {
      const sid = "11111111-1111-1111-1111-111111111111";
      await core.tracker.recordToolCall(sid, "Bash", { command: "curl h" }, "review", 0.3, "toolu_h1", { stage: "judge-ask" });
      recordPendingApproval(sid, "toolu_h1", {
        tool: "Bash",
        fingerprintHash: "fh1",
        fingerprintJson: "{}",
        summary: "curl to h",
        intentSnapshot: "test intent",
        goalEmbedding: [],
        source: "explicit",
        expiresAt: Date.now() + 60_000,
      });

      const { res, result } = fakeRes();
      await handleTrack(
        fakeReq({ session_id: sid, tool_name: "Bash", tool_use_id: "toolu_h1", user_decision: "deny", deny_reason: "no thanks" }),
        res,
      );
      result().status === 200 ? pass("200 response") : fail(`status=${result().status}`);

      const ctx = await core.tracker.getSessionContext(sid);
      const row = ctx.recentTools.find((t: any) => t.toolUseId === "toolu_h1");
      row?.outcome?.status === "user-denied" ? pass("outcome recorded on decision row") : fail(`outcome=${JSON.stringify(row?.outcome)}`);
      row?.outcome?.error === "no thanks" ? pass("deny_reason threaded through") : fail(`error=${row?.outcome?.error}`);

      consumePendingApproval(sid, "toolu_h1") === null
        ? pass("pending approval consumed (stale promotion impossible)")
        : fail("pending approval still present");

      const rows = await core.approvals.listForScope({ ownerSub: "anyone", projectRoot: "/x" });
      rows.length === 0 ? pass("no ApprovalRecord created from a refusal") : fail(`approvals=${rows.length}`);
    }

    section("Handler (flag ON): promotion stamps decision labels");
    {
      const sid = "22222222-2222-2222-2222-222222222222";
      await core.tracker.setProjectRoot(sid, "/proj");
      await core.tracker.setSessionOwner(sid, "owner-sub-1", "o@example.com");
      await core.tracker.recordToolCall(sid, "Bash", { command: "curl h2" }, "review", 0.3, "toolu_h2", { stage: "judge-ask" });
      recordPendingApproval(sid, "toolu_h2", {
        tool: "Bash",
        fingerprintHash: "fh2",
        fingerprintJson: "{}",
        summary: "curl to h2",
        intentSnapshot: "label test intent",
        goalEmbedding: [],
        source: "explicit",
        expiresAt: Date.now() + 60_000,
      });

      const { res } = fakeRes();
      await handleTrack(
        fakeReq({ session_id: sid, tool_name: "Bash", tool_input: { command: "curl h2" }, tool_use_id: "toolu_h2" }),
        res,
      );
      const rows = await core.approvals.listForScope({ ownerSub: "owner-sub-1", projectRoot: "/proj" });
      rows.length === 1 ? pass("promotion still lands with flag on") : fail(`approvals=${rows.length}`);
      rows[0]?.decision === "allow-once" ? pass("decision === 'allow-once'") : fail(`decision=${rows[0]?.decision}`);
      rows[0]?.decidedVia === "posttooluse" ? pass("decidedVia === 'posttooluse'") : fail(`decidedVia=${rows[0]?.decidedVia}`);
    }

    // ---------------------------------------------------------------------
    section("Allow-always: snapshot-diff upgrade helper");
    {
      const { InMemoryApprovalStore, upgradeRecentApprovalsToAlways, ruleToolOf } = await import(
        "../../src/approval-store.js"
      );

      ruleToolOf("Bash(curl:*)") === "Bash" ? pass("ruleToolOf Bash(curl:*) → Bash") : fail(`got ${ruleToolOf("Bash(curl:*)")}`);
      ruleToolOf("Read") === "Read" ? pass("ruleToolOf bare Read → Read") : fail(`got ${ruleToolOf("Read")}`);
      ruleToolOf("mcp__slack__send") === "mcp__slack__send" ? pass("MCP names pass through whole") : fail("mcp name mangled");

      const store = new InMemoryApprovalStore();
      const scope = { ownerSub: "u1", projectRoot: "/p" };
      const base = {
        scope,
        ownerEmail: null,
        fingerprintJson: "{}",
        summary: "s",
        intentSnapshot: "i",
        goalEmbedding: [],
        inputEmbedding: [],
        source: "explicit" as const,
        decision: "allow-once" as const,
        decidedVia: "posttooluse" as const,
      };
      await store.recordApproval({ ...base, fingerprintHash: "fp-bash", tool: "Bash" });
      await store.recordApproval({ ...base, fingerprintHash: "fp-read", tool: "Read" });
      // An old approval outside the window: fake by rewinding grantedAt.
      const old = await store.recordApproval({ ...base, fingerprintHash: "fp-old", tool: "Bash" });
      (old as any).grantedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const n = await upgradeRecentApprovalsToAlways(store, scope, ["Bash(curl:*)", "Edit"]);
      n === 1 ? pass("exactly the in-window Bash approval upgraded") : fail(`upgraded=${n}`);

      const rows = await store.listForScope(scope);
      const bash = rows.find((r: any) => r.fingerprintHash === "fp-bash");
      const read = rows.find((r: any) => r.fingerprintHash === "fp-read");
      const oldR = rows.find((r: any) => r.fingerprintHash === "fp-old");
      bash?.decision === "allow-always" && bash?.decidedVia === "snapshot-diff"
        ? pass("upgraded row labelled allow-always/snapshot-diff")
        : fail(`bash=${bash?.decision}/${bash?.decidedVia}`);
      read?.decision === "allow-once" ? pass("tool-mismatch row untouched") : fail(`read=${read?.decision}`);
      oldR?.decision === "allow-once" ? pass("out-of-window row untouched") : fail(`old=${oldR?.decision}`);

      const n2 = await upgradeRecentApprovalsToAlways(store, scope, ["Bash(git:*)"]);
      n2 === 0 ? pass("already-always rows not re-upgraded") : fail(`second pass upgraded=${n2}`);

      const n3 = await upgradeRecentApprovalsToAlways(store, scope, []);
      n3 === 0 ? pass("empty added-rules is a no-op") : fail(`empty upgraded=${n3}`);
    }

    // ---------------------------------------------------------------------
    section("Flag OFF (child process): deny branch is a complete no-op");
    {
      const self = fileURLToPath(import.meta.url);
      try {
        execFileSync("npx", ["tsx", self], {
          env: {
            ...process.env,
            DECISION_CAPTURE_CHILD: "1",
            DREDD_DECISION_CAPTURE_ENABLED: "false",
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });
        pass("child (flag off) suite passed");
      } catch (err: any) {
        fail(`child (flag off) suite failed:\n${err?.stdout ?? ""}${err?.stderr ?? ""}`);
      }
    }
  } else {
    section("Handler (flag OFF): deny body changes nothing");
    {
      const sid = "33333333-3333-3333-3333-333333333333";
      await core.tracker.recordToolCall(sid, "Bash", { command: "curl h3" }, "review", 0.3, "toolu_h3", { stage: "judge-ask" });
      recordPendingApproval(sid, "toolu_h3", {
        tool: "Bash",
        fingerprintHash: "fh3",
        fingerprintJson: "{}",
        summary: "curl to h3",
        intentSnapshot: "i",
        goalEmbedding: [],
        source: "explicit",
        expiresAt: Date.now() + 60_000,
      });

      const { res, result } = fakeRes();
      await handleTrack(
        fakeReq({ session_id: sid, tool_name: "Bash", tool_use_id: "toolu_h3", user_decision: "deny", deny_reason: "x" }),
        res,
      );
      result().status === 200 ? pass("still 200 (fire-and-forget contract)") : fail(`status=${result().status}`);

      const ctx = await core.tracker.getSessionContext(sid);
      const row = ctx.recentTools.find((t: any) => t.toolUseId === "toolu_h3");
      row?.outcome === undefined ? pass("no outcome recorded (flag off)") : fail(`outcome=${JSON.stringify(row?.outcome)}`);
      consumePendingApproval(sid, "toolu_h3") !== null
        ? pass("pending approval untouched (flag off)")
        : fail("pending approval was consumed");
    }

    section("Flag OFF: promotions carry no decision labels");
    {
      const sid = "44444444-4444-4444-4444-444444444444";
      await core.tracker.setProjectRoot(sid, "/proj-off");
      await core.tracker.setSessionOwner(sid, "owner-sub-off", null);
      await core.tracker.recordToolCall(sid, "Bash", { command: "curl h4" }, "review", 0.3, "toolu_h4", { stage: "judge-ask" });
      recordPendingApproval(sid, "toolu_h4", {
        tool: "Bash",
        fingerprintHash: "fh4",
        fingerprintJson: "{}",
        summary: "curl to h4",
        intentSnapshot: "off intent",
        goalEmbedding: [],
        source: "explicit",
        expiresAt: Date.now() + 60_000,
      });

      const { res } = fakeRes();
      await handleTrack(
        fakeReq({ session_id: sid, tool_name: "Bash", tool_input: { command: "curl h4" }, tool_use_id: "toolu_h4" }),
        res,
      );
      const rows = await core.approvals.listForScope({ ownerSub: "owner-sub-off", projectRoot: "/proj-off" });
      rows.length === 1 ? pass("promotion lands") : fail(`approvals=${rows.length}`);
      rows[0]?.decision === undefined ? pass("no decision label (flag off)") : fail(`decision=${rows[0]?.decision}`);
    }
  }

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
