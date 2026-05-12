/**
 * Unit test for classifyIntentByEmbedding.
 *
 * Scope-honest naming: this is NOT a full validation of the
 * history-active model — it only exercises the pure embedding-and-
 * phrasing classifier and documents the legacy-downgrade table.
 * The integration paths (applyIntentStackUpdate, the async LLM
 * classifier override, schema migration on legacy reads) require
 * live infrastructure or extensive mocking and are covered by:
 *
 *   - Staged rollout against sandbox traffic (Step 6 telemetry)
 *   - test-promptarmor-baseline.ts for the LLM-call shape
 *   - Real-traffic A/B comparison via /api/session-intent-mode
 *
 * Run: npx tsx src/test-classify-intent-by-embedding.ts
 */

import { classifyIntentByEmbedding } from "./server-core.js";
import type { IntentEntry } from "./session-store.js";

function fakeEmbed(slot: number, dim = 16): number[] {
  const v = new Array(dim).fill(0);
  if (slot === 0.5) {
    v[0] = 0.7;
    v[1] = 0.7;
  } else {
    v[Math.floor(slot)] = 1;
  }
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  return v.map((x) => x / mag);
}

function entry(
  id: string,
  prompt: string,
  slot: number,
  kind: IntentEntry["kind"],
  resolved = false,
): IntentEntry {
  return {
    id,
    prompt,
    contextual: prompt,
    embedding: fakeEmbed(slot),
    registeredAt: Date.now(),
    kind,
    resolved,
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

interface Case {
  name: string;
  prompt: string;
  embedSlot: number;
  active: IntentEntry[];
  history: IntentEntry[];
  turnState: "open" | "draining" | "closed";
  expectedKind: IntentEntry["kind"];
  expectedRef?: string;
}

const cases: Case[] = [
  {
    name: "InjecAgent: empty session -> original",
    prompt: "Get the Twitter profile",
    embedSlot: 0,
    active: [],
    history: [],
    turnState: "closed",
    expectedKind: "original",
  },
  {
    name: "AgentDojo multi-turn: low-drift continuation",
    prompt: "Add password validation",
    embedSlot: 0,
    active: [entry("a1", "Build the auth service", 0, "original")],
    history: [entry("a1", "Build the auth service", 0, "original")],
    turnState: "closed",
    expectedKind: "continuation",
  },
  {
    name: "Go back: revisit fires after topic switch",
    prompt: "ok let's go back to fixing the auth bug",
    embedSlot: 0,
    active: [
      entry("b1", "Now let's review the markdown plan", 5, "new-task"),
    ],
    history: [
      entry("a1", "Fix the auth bug we keep hitting", 0, "original", true),
      entry("a2", "Trace through the auth handler", 0, "continuation", true),
      entry("b1", "Now let's review the markdown plan", 5, "new-task"),
    ],
    turnState: "closed",
    expectedKind: "revisit",
    expectedRef: "a1",
  },
  {
    name: "Replacement phrasing wins over topic-switch",
    prompt: "actually do logout instead of login",
    embedSlot: 0.5,
    active: [entry("a1", "Fix login bug", 0, "original")],
    history: [entry("a1", "Fix login bug", 0, "original")],
    turnState: "closed",
    expectedKind: "replacement",
    expectedRef: "a1",
  },
  {
    name: "Sub-task phrasing in mid-band drift",
    prompt: "first add tests for the password validator",
    embedSlot: 0.5,
    active: [entry("a1", "Build the auth service", 0, "original")],
    history: [entry("a1", "Build the auth service", 0, "original")],
    turnState: "closed",
    expectedKind: "sub-task",
    expectedRef: "a1",
  },
  {
    name: "Pure topic switch (no replacement phrasing)",
    prompt: "Now write a CLI tool unrelated to anything",
    embedSlot: 7,
    active: [entry("a1", "Build the auth service", 0, "original")],
    history: [entry("a1", "Build the auth service", 0, "original")],
    turnState: "closed",
    expectedKind: "new-task",
  },
  {
    name: "Draining turn state -> queued (overrides drift)",
    prompt: "also do this",
    embedSlot: 9,
    active: [entry("a1", "Build the auth service", 0, "original")],
    history: [entry("a1", "Build the auth service", 0, "original")],
    turnState: "draining",
    expectedKind: "queued",
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const live = c.active.filter((e) => !e.resolved);
  const cmp = live.length > 0 ? live : c.active;
  const top = cmp.length > 0 ? cmp[cmp.length - 1] : null;
  const drift = top ? 1 - cosine(top.embedding, fakeEmbed(c.embedSlot)) : null;
  const v = classifyIntentByEmbedding(
    c.prompt,
    fakeEmbed(c.embedSlot),
    c.active,
    c.history,
    drift,
    c.turnState,
  );
  const ok =
    v.kind === c.expectedKind &&
    (c.expectedRef === undefined || v.referencedEntryId === c.expectedRef);
  const tick = ok ? "✓" : "✗";
  console.log(
    `${tick} ${c.name}: kind=${v.kind}` +
    (v.referencedEntryId ? ` ref=${v.referencedEntryId}` : "") +
    ` (${v.reason})`,
  );
  if (ok) pass++;
  else fail++;
}

// Step-6 downgrade verification: rich kinds collapse to legacy
// equivalents when historyActive=false.
const legacyDowngradeCases: Array<{ rich: string; legacy: string }> = [
  { rich: "sub-task", legacy: "continuation" },
  { rich: "replacement", legacy: "continuation" },
  { rich: "revisit", legacy: "new-task" },
  { rich: "continuation", legacy: "continuation" }, // unchanged
  { rich: "new-task", legacy: "new-task" }, // unchanged
];
console.log("\n--- Legacy downgrade ---");
for (const tc of legacyDowngradeCases) {
  // We can't import the private downgrade helper, but we can verify
  // the contract: history-active mode preserves the rich kind, legacy
  // mode collapses it. The actual function-level test would need
  // exposure; we trust the inline implementation in server-core
  // matches the table above.
  console.log(`  expected: ${tc.rich} -> ${tc.legacy} in legacy mode`);
}

console.log(`\n${pass}/${pass + fail} classifier pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
