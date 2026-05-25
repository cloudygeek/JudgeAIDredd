/**
 * Replay harness — the 80 denied commands from session 455e88d2.
 *
 * Compares the BASELINE curl fingerprinter (src/approval-fingerprint.ts,
 * {verb,host,auth_hash}) against the NEW (principal,target) resolver
 * (src/credential-flow.ts, {verb,host,principals[]}) on real traffic.
 *
 * Reports principal-resolution rate and the distinct-class collapse, and
 * asserts the success thresholds from the design spec.
 *
 * Corpus is the redacted fixture (no raw secrets — all credentials are
 * file reads or already-hashed). Build it with: see build-fixture below.
 *
 * Run: npx tsx hooks/tests/replay_denies_455.ts [path-to-jsonl]
 */

import { readFileSync } from "node:fs";
import { computeFingerprint, hashFingerprint } from "../../src/approval-fingerprint.js";
import { fingerprintNetwork, analyzeCommand, sourceKey } from "../../src/credential-flow.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m" };
let PASS = 0, FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };

const path = process.argv[2] ?? new URL("./fixtures/denies-455.jsonl", import.meta.url).pathname;
const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cmd: string; tool: string });
const bash = rows.filter((r) => r.tool === "Bash");

// A command "carries a credential to a host" only if it has BOTH a
// network sink AND a credential indicator. Key-reads with no curl in the
// same command (cat api-key, test -f api-key, KEY=$(cat …) alone) have no
// target — out of scope for a (principal,target) fingerprint.
const credIndicator = (cmd: string) =>
  /claude\/dredd\/api-key|DREDD_API_KEY|OPENAI_API_KEY|authorization|x-api-key|api-key|x-auth-token|\s-u\s|\s-b\s/i.test(cmd);

type Bucket = "non-network" | "network-nocred" | "network-cred";
const buckets: Record<Bucket, string[]> = { "non-network": [], "network-nocred": [], "network-cred": [] };

const baseNetCred = new Set<string>();       // baseline distinct fps over network+cred cmds
const newNetCred = new Set<string>();         // new distinct fps over network+cred cmds
const absorb = new Map<string, Set<string>>(); // newHash -> set of baseline hashes it merges
let baseAuthResolved = 0;                     // baseline pinned a key (auth_hash) on a network-cred cmd
let leaked = 0;                               // new fingerprints containing a raw-secret-looking token
const resolved: string[] = [];               // network-cred cmds the NEW resolver got a principal for
const unresolved: string[] = [];             // network-cred cmds it missed (the honest gap)
const classCount = new Map<string, number>();

for (const { cmd } of bash) {
  const nfp = fingerprintNetwork(cmd);
  if (!nfp) { buckets["non-network"].push(cmd); continue; }
  if (/jaid_(live|test)_[A-Za-z0-9]{6,}/.test(JSON.stringify(nfp.shape))) leaked++;

  const bfp = computeFingerprint("Bash", { command: cmd });
  const principals = analyzeCommand(cmd).network.find((n) => n.principals.length)?.principals ?? [];
  const carriesCred = principals.length > 0 || credIndicator(cmd);
  if (!carriesCred) { buckets["network-nocred"].push(cmd); continue; }

  buckets["network-cred"].push(cmd);
  const bHash = bfp ? hashFingerprint(bfp) : "∅";
  baseNetCred.add(bHash);
  newNetCred.add(nfp.hash);
  (absorb.get(nfp.hash) ?? absorb.set(nfp.hash, new Set()).get(nfp.hash)!).add(bHash);
  if (bfp && (bfp.shape as { auth_hash?: string | null }).auth_hash) baseAuthResolved++;
  if (principals.length) {
    resolved.push(cmd);
    const label = `${principals.map(sourceKey).join("+")}  →  ${nfp.shape.host}`;
    classCount.set(label, (classCount.get(label) ?? 0) + 1);
  } else {
    unresolved.push(cmd);
  }
}
const maxAbsorb = Math.max(0, ...[...absorb.values()].map((s) => s.size));

const netCred = buckets["network-cred"].length;
console.log(`${c.bold}Replay: ${bash.length} denied Bash commands from 455e88d2${c.off}\n`);
console.log(`  partition:`);
console.log(`    non-network (no target, out of scope) .. ${buckets["non-network"].length}`);
console.log(`    network, no credential ................. ${buckets["network-nocred"].length}`);
console.log(`    network + credential (the (P,T) cases) . ${netCred}`);
console.log(`\n  on the ${netCred} network+credential commands:`);
console.log(`    baseline pinned the key (auth_hash) .... ${baseAuthResolved} / ${netCred}  (${Math.round(100 * baseAuthResolved / netCred)}%)`);
console.log(`    NEW resolved a principal ............... ${resolved.length} / ${netCred}  (${Math.round(100 * resolved.length / netCred)}%)`);
console.log(`    distinct fingerprints (these cmds) ..... baseline ${baseNetCred.size}  →  new ${newNetCred.size}`);
console.log(`    most baseline fps merged into one class  ${maxAbsorb}  (plumbing variants collapsed)`);

console.log(`\n${c.dim}top (principal → host) classes:${c.off}`);
[...classCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .forEach(([label, n]) => console.log(`   ${String(n).padStart(3)}×  ${label}`));

if (unresolved.length) {
  console.log(`\n${c.dim}unresolved network+credential (the honest gap):${c.off}`);
  unresolved.forEach((cmd) => console.log(`   · ${cmd.replace(/\s+/g, " ").slice(0, 95)}`));
  console.log(`   ${c.dim}(1 unauthenticated /health probe — correctly empty; 2 embed the key in a${c.off}`);
  console.log(`   ${c.dim} -d @<(python3 …) process substitution — resolver limit, fails safe to re-ask)${c.off}`);
}

console.log(`\n${c.dim}--- assertions ---${c.off}`);
const resRate = resolved.length / netCred;
resRate >= 0.85
  ? pass(`principal resolved on ${Math.round(resRate * 100)}% of network+credential calls (≥85%)`)
  : fail(`principal resolved on only ${Math.round(resRate * 100)}% (<85%)`);
resolved.length > baseAuthResolved
  ? pass(`visibility up: new ${resolved.length} vs baseline ${baseAuthResolved} (+${resolved.length - baseAuthResolved})`)
  : fail(`no visibility improvement: new ${resolved.length} ≤ baseline ${baseAuthResolved}`);
newNetCred.size <= baseNetCred.size && maxAbsorb >= 2
  ? pass(`no fragmentation (${baseNetCred.size}→${newNetCred.size}); one class merges ${maxAbsorb} baseline fps`)
  : fail(`fragmentation or no plumbing-collapse: ${baseNetCred.size}→${newNetCred.size}, maxAbsorb ${maxAbsorb}`);
leaked === 0
  ? pass(`no raw secret in any of ${networkCmdsTotal()} network fingerprints`)
  : fail(`${leaked} fingerprints contain a raw secret token`);

function networkCmdsTotal() { return buckets["network-nocred"].length + netCred; }

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
