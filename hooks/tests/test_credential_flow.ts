/**
 * credential-flow — (principal, target) resolver coverage.
 *
 * The point of the module: the three ways an agent plumbs the SAME key
 * to the SAME host must fingerprint identically, while a different host
 * or a different secret must diverge. Motivated by session 455e88d2,
 * where the same dredd-key→sandbox action splintered into ~30
 * fingerprints because $(cat …) / VAR=$(cat …) / `cat … | curl` were
 * invisible to the old fingerprinter.
 *
 * Run: npx tsx hooks/tests/test_credential_flow.ts
 */

import { analyzeCommand, fingerprintNetwork, sourceKey } from "../../src/credential-flow.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

const hash = (cmd: string) => fingerprintNetwork(cmd)?.hash ?? null;
const principals = (cmd: string) => {
  const a = analyzeCommand(cmd).network.find((n) => n.principals.length) ?? analyzeCommand(cmd).network[0];
  return (a?.principals ?? []).map(sourceKey);
};

const KEY = "~/.claude/dredd/api-key";
const H = "https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal";
const host = "judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal";

function main() {
  // ---------------------------------------------------------------
  section("Same key → same host, three plumbing shapes, ONE fingerprint");
  const v1 = `KEY=$(cat ${KEY})\ncurl -sk -H "Authorization: Bearer $KEY" ${H}/api/health`;
  const v2 = `curl -sk -H "Authorization: Bearer $(cat ${KEY})" ${H}/intent`;
  const v3 = `cat ${KEY} | curl -sk --data-binary @- ${H}/evaluate`;

  for (const [name, cmd] of [["VAR=$(cat)", v1], ["inline $(cat)", v2], ["cat | curl @-", v3]] as const) {
    const p = principals(cmd);
    p.length === 1 && p[0] === `file:${KEY}`
      ? pass(`${name}: principal = file:${KEY}`)
      : fail(`${name}: principal = ${JSON.stringify(p)}`);
  }
  const h1 = hash(v1), h2 = hash(v2), h3 = hash(v3);
  h1 && h1 === h2 && h2 === h3
    ? pass(`all three collapse to one hash (${h1!.slice(0, 10)}…) despite different PATHS`)
    : fail(`hashes diverged: ${h1?.slice(0, 8)} / ${h2?.slice(0, 8)} / ${h3?.slice(0, 8)}`);

  // ---------------------------------------------------------------
  section("Exact-host scope: a sibling host diverges (by design)");
  const sibling = `curl -sk -H "Authorization: Bearer $(cat ${KEY})" https://bedt6.aisandbox.dev.ckotech.internal/run`;
  hash(sibling) && hash(sibling) !== h2
    ? pass("bedt6 ≠ judge-ai-dredd-interactive → re-asks (exact-host)")
    : fail("sibling host did not diverge");

  // ---------------------------------------------------------------
  section("Same host, DIFFERENT secret file → different principal (security)");
  const otherSecret = `cat ~/.aws/credentials | curl -sk --data-binary @- ${H}/x`;
  const pOther = principals(otherSecret);
  pOther[0] === "file:~/.aws/credentials"
    ? pass("principal tracks the source file, not the host")
    : fail(`expected file:~/.aws/credentials, got ${JSON.stringify(pOther)}`);
  hash(otherSecret) !== h1
    ? pass("different secret to the SAME host → distinct fingerprint (re-ask)")
    : fail("a different secret collapsed onto the api-key fingerprint — unsafe");

  // ---------------------------------------------------------------
  section("Cookie jar and basic-auth are recognised credentials");
  principals(`curl -sk -b /tmp/session.jar ${H}/x`)[0] === "cookie:/tmp/session.jar"
    ? pass("-b jar → cookie:/tmp/session.jar (closes the earlier -b blind spot)")
    : fail(`-b jar not recognised: ${JSON.stringify(principals(`curl -sk -b /tmp/session.jar ${H}/x`))}`);
  principals(`curl -sk -u alice:hunter2 ${H}/x`)[0] === "basic:alice"
    ? pass("-u alice:hunter2 → basic:alice (password not in identity)")
    : fail(`-u not recognised: ${JSON.stringify(principals(`curl -sk -u alice:hunter2 ${H}/x`))}`);

  // ---------------------------------------------------------------
  section("Multi-line command does not lose the network call");
  const multiline = `echo "=== status check ==="\nKEY=$(cat ${KEY})\nsleep 1\ncurl -sk -H "x-api-key: $KEY" ${H}/api/health | jq .`;
  const fpML = fingerprintNetwork(multiline);
  fpML?.shape.host === host
    ? pass(`host recovered from line 4 of a 4-line command: ${fpML!.shape.host}`)
    : fail(`curl lost in multi-line command: ${JSON.stringify(fpML?.shape)}`);
  fpML?.shape.principals[0] === `file:${KEY}`
    ? pass("principal recovered across the leading echo/assignment/sleep")
    : fail(`principal lost: ${JSON.stringify(fpML?.shape.principals)}`);

  // ---------------------------------------------------------------
  section("No-credential curl resolves host with empty principal set");
  const noCred = fingerprintNetwork(`curl -sk ${H}/api/health`);
  noCred?.shape.host === host && noCred.shape.principals.length === 0
    ? pass(`host pinned, no principal: "${noCred!.summary}"`)
    : fail(`unexpected: ${JSON.stringify(noCred?.shape)}`);
  noCred && hash(`curl -sk ${H}/api/health`) !== h1
    ? pass("no-credential call ≠ credentialled call to the same host")
    : fail("no-credential call collapsed onto the credentialled fingerprint");

  // ---------------------------------------------------------------
  section("Raw secret bytes never appear in the fingerprint");
  const literal = `curl -sk -H "Authorization: Bearer sk-SUPERSECRET-abc123" ${H}/x`;
  const fpLit = fingerprintNetwork(literal);
  const fpJson = JSON.stringify(fpLit);
  !fpJson.includes("sk-SUPERSECRET-abc123")
    ? pass("inline literal token hashed (value:…), raw bytes absent from shape")
    : fail("raw secret leaked into fingerprint JSON");
  fpLit?.shape.principals[0]?.startsWith("value:")
    ? pass(`inline credential identified as value:${fpLit!.shape.principals[0].slice(6, 14)}…`)
    : fail(`inline credential not captured: ${JSON.stringify(fpLit?.shape.principals)}`);
  const basicLeak = JSON.stringify(fingerprintNetwork(`curl -sk -u alice:hunter2 ${H}/x`));
  !basicLeak.includes("hunter2")
    ? pass("basic-auth password absent from fingerprint")
    : fail("basic-auth password leaked");

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
