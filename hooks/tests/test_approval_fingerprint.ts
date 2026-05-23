/**
 * Approval fingerprinter — chained-command + env-expansion coverage.
 *
 * Regression test for the bug surfaced on session 654fa809 (2026-05-23):
 * a command like
 *
 *   KEY=...
 *   URL=https://host/
 *   echo "=== auth check ==="
 *   curl ... "${URL}?..."
 *   curl -H "x-api-key: $KEY" "${URL}?..."
 *
 * used to fingerprint as the GENERIC bash shape of its first token
 * (`echo "=== auth check ===" curl`), which is blind to the host and key.
 * An approval granted for that shape would then auto-allow a curl to ANY
 * host as long as the leading echo text matched.
 *
 * The fix: split chained statements, expand same-command env assignments,
 * and fingerprint the network sub-command (preferring the authed one) so
 * the approval pins {host, auth_hash}.
 *
 * Run: npx tsx hooks/tests/test_approval_fingerprint.ts
 */

import { computeFingerprint, hashFingerprint } from "../../src/approval-fingerprint.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

function fp(command: string) {
  return computeFingerprint("Bash", { command });
}
function hash(command: string): string | null {
  const f = fp(command);
  return f ? hashFingerprint(f) : null;
}

const SCREENSHOT = `KEY=69afeb82ff805fedd0c023dc5d16b4b33c03c14a5d713e2c9224665bf1373074
URL=https://fffwaegekwvwyft7l64htrmmwe0dzgqa.lambda-url.eu-west-1.on.aws/
echo "=== auth check: no key (expect 401) ==="
curl -s -o /dev/null -w "%{http_code}\\n" "\${URL}?group=phases&n=2"
echo "=== live data: group=phases, n=2 (expect 200 + series) ==="
curl -s -H "x-api-key: $KEY" "\${URL}?group=phases&n=2" | jq .`;

function main() {
  section("Screenshot command pins the curl host + key, not the leading echo");

  const f = fp(SCREENSHOT);
  if (!f) { fail("fingerprint was null"); }
  else {
    const shape = f.shape as { verb?: string; host?: string; auth_hash?: string | null };
    shape.verb === "curl"
      ? pass("fingerprint is the curl shape, not generic-bash echo")
      : fail(`expected curl shape, got ${JSON.stringify(f.shape)}`);
    shape.host === "fffwaegekwvwyft7l64htrmmwe0dzgqa.lambda-url.eu-west-1.on.aws"
      ? pass(`host resolved from \${URL}: ${shape.host}`)
      : fail(`host not resolved: ${shape.host}`);
    shape.auth_hash
      ? pass(`auth_hash pinned from x-api-key: ${shape.auth_hash.slice(0, 8)}…`)
      : fail("auth_hash null — x-api-key not captured");
    !f.summary.includes(SCREENSHOT.slice(0, 10)) && !f.summary.includes("=== auth check")
      ? pass(`summary is host-based: "${f.summary}"`)
      : fail(`summary still leaks the echo body: "${f.summary}"`);
    // The raw key must never appear in the persisted fingerprint JSON.
    !JSON.stringify(f).includes("69afeb82ff805fedd")
      ? pass("raw API key absent from fingerprint (only hash persisted)")
      : fail("RAW KEY LEAKED into fingerprint");
  }

  section("Different host re-prompts (the core bug)");

  const sameHost = hash(SCREENSHOT);
  const otherHost = hash(SCREENSHOT.replace(
    "fffwaegekwvwyft7l64htrmmwe0dzgqa.lambda-url.eu-west-1.on.aws",
    "evil-attacker-host.example.com",
  ));
  sameHost && otherHost && sameHost !== otherHost
    ? pass("curl to a different host yields a different fingerprint → re-prompt")
    : fail("different host produced the SAME fingerprint — bug not fixed");

  section("Different key re-prompts");

  const otherKey = hash(SCREENSHOT.replace(
    "69afeb82ff805fedd0c023dc5d16b4b33c03c14a5d713e2c9224665bf1373074",
    "00000000000000000000000000000000000000000000000000000000deadbeef",
  ));
  sameHost && otherKey && sameHost !== otherKey
    ? pass("different API key yields a different fingerprint → re-prompt")
    : fail("different key produced the SAME fingerprint");

  section("Cosmetic echo edits do NOT re-prompt (same host+key)");

  const editedEcho = hash(SCREENSHOT.replace(
    "=== auth check: no key (expect 401) ===",
    "=== checking auth, expecting 401 now ===",
  ));
  sameHost && editedEcho && sameHost === editedEcho
    ? pass("changing the echo text keeps the same fingerprint (host+key unchanged)")
    : fail("cosmetic echo edit changed the fingerprint — too brittle");

  section("Plain leading curl still works (no regression)");

  const plain = fp('curl -H "Authorization: Bearer sk_live_abc123" https://api.stripe.com/v1/charges');
  const ps = plain?.shape as { verb?: string; host?: string; auth_hash?: string | null } | undefined;
  ps?.host === "api.stripe.com" && ps?.auth_hash
    ? pass(`plain curl pins host+auth: ${plain!.summary}`)
    : fail(`plain curl regressed: ${JSON.stringify(plain)}`);

  section("Generic bash unchanged (git status)");

  const git = fp("git status --short");
  const gs = git?.shape as { argv?: string[] } | undefined;
  gs?.argv && gs.argv[0] === "git" && gs.argv[1] === "status"
    ? pass(`git status → generic argv shape: ${JSON.stringify(gs.argv)}`)
    : fail(`git status fingerprint wrong: ${JSON.stringify(git)}`);

  section("echo-only command falls back to generic (no false curl match)");

  const echoOnly = fp('echo "hello world"');
  const es = echoOnly?.shape as { argv?: string[]; verb?: string } | undefined;
  es?.argv && es.argv[0] === "echo"
    ? pass("echo-only command → generic echo shape")
    : fail(`echo-only fingerprint wrong: ${JSON.stringify(echoOnly)}`);

  section("Chained echo;curl with literal URL (no env var)");

  const litChain = fp('echo "checking"; curl -H "Authorization: Bearer tok" https://api.example.com/x');
  const ls = litChain?.shape as { verb?: string; host?: string } | undefined;
  ls?.verb === "curl" && ls?.host === "api.example.com"
    ? pass(`echo;curl literal → curl shape host=${ls.host}`)
    : fail(`echo;curl literal fingerprint wrong: ${JSON.stringify(litChain)}`);

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
