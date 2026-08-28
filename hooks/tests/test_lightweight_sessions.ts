// hooks/tests/test_lightweight_sessions.ts
// Run: npx tsx hooks/tests/test_lightweight_sessions.ts
import { DynamoSessionStore } from "../../src/dynamo-session-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0, FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++)
       : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);

// Minimal fake DynamoDBDocumentClient: records every command and returns
// canned results. Each command class is identified by constructor name.
function fakeClient(opts: { queryItems?: any[]; getItem?: any } = {}) {
  const sent: any[] = [];
  return {
    sent,
    async send(cmd: any) {
      sent.push(cmd);
      const n = cmd.constructor.name;
      if (n === "QueryCommand") return { Items: opts.queryItems ?? [] };
      if (n === "GetCommand") return { Item: opts.getItem };
      return {};
    },
  } as any;
}

async function main() {
  // --- Task 2: listSessions maps META aggregates -> summary fields ---
  const metaRow = {
    sessionId: "s1", sk: "META", startedAt: "t0", endedAt: null,
    originalIntent: { prompt: "do the thing" }, currentTurn: 3,
    hijackStrikes: 0, lockedHijacked: false, ownerSub: "u1", ownerEmail: "u@x",
    aggToolCalls: 7, aggDenied: 2, aggFiles: 4, lastClassification: "drifting",
    clientIp: "1.2.3.4", userPermissions: { allow: ["Read"], deny: [], ask: [] },
  };
  const store = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0",
    client: fakeClient({ queryItems: [metaRow] }),
  });
  const list = await store.listSessions(50);
  const s = list[0];
  ok("toolCallCount from aggToolCalls", s.toolCallCount === 7);
  ok("deniedCount from aggDenied", s.deniedCount === 2);
  ok("fileWriteCount from aggFiles", s.fileWriteCount === 4);
  ok("lastClassification mapped", s.lastClassification === "drifting");
  ok("clientIp mapped", s.clientIp === "1.2.3.4");
  ok("userPermissions mapped", (s.userPermissions?.allow ?? []).length === 1);

  const store2 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0",
    client: fakeClient({ queryItems: [{ sessionId: "old", sk: "META", startedAt: "t0", currentTurn: 0 }] }),
  });
  const old = (await store2.listSessions(50))[0];
  ok("legacy row: counts default 0", old.toolCallCount === 0 && old.deniedCount === 0 && old.fileWriteCount === 0);
  ok("legacy row: lastClassification null", old.lastClassification === null || old.lastClassification === undefined);

  // --- Task 3: recordToolCall issues an atomic ADD on META ---
  const fc = fakeClient({ getItem: { sessionId: "s2", sk: "META", currentTurn: 1 } });
  const store3 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0", client: fc,
  });
  await store3.recordToolCall("s2", "Bash", { command: "ls" }, "deny", 0.1, "tool_x");
  const updates = fc.sent.filter((c: any) => c.constructor.name === "UpdateCommand"
    && c.input?.Key?.sk === "META");
  const counterUpd = updates.find((u: any) =>
    /ADD/.test(u.input.UpdateExpression) && /aggToolCalls/.test(u.input.UpdateExpression));
  ok("recordToolCall ADDs aggToolCalls on META", !!counterUpd);
  ok("deny also ADDs aggDenied", !!counterUpd && /aggDenied/.test(counterUpd.input.UpdateExpression));

  // --- Task 4: recordFileWrite ADDs aggFiles only for a NEW path ---
  // New path: GetCommand(FILE#W) returns no Item -> else branch.
  const fcNew = fakeClient({ getItem: undefined });
  const store4 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0", client: fcNew,
  });
  await store4.recordFileWrite("s3", "/tmp/a.txt", "hello", false);
  const fileAdd = fcNew.sent.find((c: any) => c.constructor.name === "UpdateCommand"
    && c.input?.Key?.sk === "META" && /ADD aggFiles/.test(c.input.UpdateExpression));
  ok("new file path ADDs aggFiles on META", !!fileAdd);

  // Existing path: GetCommand(FILE#W) returns an Item -> if branch, NO aggFiles add.
  const fcExist = fakeClient({ getItem: { path: "/tmp/a.txt", writeCount: 1, sk: "FILE#W#x" } });
  const store5 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0", client: fcExist,
  });
  await store5.recordFileWrite("s3", "/tmp/a.txt", "more", true);
  const fileAdd2 = fcExist.sent.find((c: any) => c.constructor.name === "UpdateCommand"
    && c.input?.Key?.sk === "META" && /ADD aggFiles/.test(c.input.UpdateExpression));
  ok("repeat file path does NOT add aggFiles", !fileAdd2);

  // --- Task 5: recordTurnMetrics SETs lastClassification on META ---
  const fcm = fakeClient({ getItem: { sessionId: "s4", sk: "META", currentTurn: 2 } });
  const store6 = new DynamoSessionStore({
    tableName: "jaid-sessions", region: "eu-west-1",
    embeddingModel: "eu.cohere.embed-v4:0", client: fcm,
  });
  // driftFromOriginal 0.4 -> classifyDrift -> "drifting" (per tracker thresholds)
  await store6.recordTurnMetrics("s4", 0.4, 0.1, 3, 1, false, false);
  const classUpd = fcm.sent.find((c: any) => c.constructor.name === "UpdateCommand"
    && c.input?.Key?.sk === "META" && /SET lastClassification/.test(c.input.UpdateExpression));
  ok("recordTurnMetrics SETs lastClassification on META", !!classUpd);
  ok("lastClassification value is the derived class (0.4 -> drifting)", !!classUpd && classUpd.input.ExpressionAttributeValues[":c"] === "drifting");

  // --- Task 6: InMemorySessionStore.listSessions derives aggregates ---
  const { InMemorySessionStore } = await import("../../src/session-tracker.js");
  const mem = new InMemorySessionStore("nomic-embed-text");
  await mem.registerIntent("m1", "do a thing");
  await mem.recordToolCall("m1", "Bash", { command: "ls" }, "allow", 0.9, "t1");
  await mem.recordToolCall("m1", "Bash", { command: "rm x" }, "deny", 0.1, "t2");
  await mem.recordFileWrite("m1", "/tmp/x", "hi", false);
  await mem.recordFileWrite("m1", "/tmp/x", "hi2", true);   // same path
  await mem.recordFileWrite("m1", "/tmp/y", "hi", false);   // new path
  const ms = (await mem.listSessions(50)).find((x: any) => x.sessionId === "m1");
  ok("in-memory toolCallCount = 2", ms?.toolCallCount === 2);
  ok("in-memory deniedCount = 1", ms?.deniedCount === 1);
  ok("in-memory fileWriteCount = 2 distinct", ms?.fileWriteCount === 2);

  // --- Task 7: sessionListEntry maps a SessionSummary -> lightweight entry ---
  const { sessionListEntry } = await import("../../src/server-dashboard.js");
  const entry = sessionListEntry({
    sessionId: "s9", startedAt: "t0", endedAt: null, originalTask: "fix bug",
    currentTurn: 4, hijackStrikes: 0, lockedHijacked: false,
    ownerSub: "u1", ownerEmail: "u@x",
    toolCallCount: 5, deniedCount: 1, fileWriteCount: 3, lastClassification: "scope-creep",
    clientIp: "9.9.9.9", userPermissions: { allow: ["Read"], deny: [], ask: [] },
  });
  ok("entry.summary.toolCalls", entry.summary.toolCalls === 5);
  ok("entry.summary.denied", entry.summary.denied === 1);
  ok("entry.summary.filesWritten", entry.summary.filesWritten === 3);
  ok("entry.summary.turns = currentTurn", entry.summary.turns === 4);
  ok("entry.turnMetrics carries last classification", entry.turnMetrics[0].classification === "scope-creep");
  ok("entry.clientIp + userPermissions preserved", entry.clientIp === "9.9.9.9" && entry.userPermissions.allow.length === 1);
  ok("entry.projectRoot preserved for the list row", "projectRoot" in entry);
  ok("entry has NO full toolCalls/filesWritten arrays", entry.toolCalls === undefined && entry.filesWritten === undefined);

  console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off} (${PASS}/${PASS + FAIL})`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main();
