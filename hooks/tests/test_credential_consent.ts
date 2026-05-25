/**
 * Credential→host consent — capture / match / suppress.
 *
 * Exercises the version-aware approval fingerprint (computeApprovalFingerprint)
 * + the InMemoryApprovalStore round-trip that backs interactive-mode
 * consent. Proves the user-facing contract:
 *
 *   - judge warns → user accepts → store (credential, exact-host) pair
 *   - a later call with the SAME pair but DIFFERENT plumbing matches
 *     (warning suppressed)
 *   - a different exact host does NOT match (re-ask)
 *   - the pair carries isCredentialPair=true, which is the signal
 *     evaluate.ts uses to SKIP the intent-drift backstop
 *   - flag OFF reverts to the legacy fingerprint (no cross-matching)
 *
 * Run: npx tsx hooks/tests/test_credential_consent.ts
 */

import { computeApprovalFingerprint, LEGACY_FP_VERSION } from "../../src/approval-fingerprint.js";
import { CREDENTIAL_FP_VERSION } from "../../src/credential-flow.js";
import { InMemoryApprovalStore } from "../../src/approval-store.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0, FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

const ON = { credentialConsent: true };
const OFF = { credentialConsent: false };
const fpOn = (cmd: string) => computeApprovalFingerprint("Bash", { command: cmd }, ON)!;

const KEY = "~/.claude/dredd/api-key";
const H = "https://judge-ai-dredd-interactive.aisandbox.dev.ckotech.internal";
// same (file:KEY, exact host), three plumbing shapes:
const v1 = `KEY=$(cat ${KEY})\ncurl -sk -H "Authorization: Bearer $KEY" ${H}/api/health`;
const v2 = `curl -sk -H "Authorization: Bearer $(cat ${KEY})" ${H}/intent`;
const v3 = `cat ${KEY} | curl -sk --data-binary @- ${H}/evaluate`;
const diffHost = `curl -sk -H "Authorization: Bearer $(cat ${KEY})" https://bedt6.aisandbox.dev.ckotech.internal/run`;

async function main() {
  section("Flag ON: Bash network call → credential-pair fingerprint");
  const f1 = fpOn(v1);
  f1.version === CREDENTIAL_FP_VERSION && f1.isCredentialPair
    ? pass(`version ${CREDENTIAL_FP_VERSION}, isCredentialPair=true`)
    : fail(`got version ${f1.version}, isCredentialPair=${f1.isCredentialPair}`);
  f1.summary.includes(`credential file:${KEY}`)
    ? pass(`summary names the source: "${f1.summary}"`)
    : fail(`summary wrong: "${f1.summary}"`);

  section("Capture → match across plumbing → SUPPRESS");
  const store = new InMemoryApprovalStore();
  const scope = { ownerSub: "u1", projectRoot: "/proj" };
  // user accepted the warning on v1 → record the pair
  await store.recordApproval({
    scope, ownerEmail: null,
    fingerprintHash: f1.hash, fingerprintJson: f1.fingerprintJson, summary: f1.summary,
    tool: "Bash", intentSnapshot: "fire the benchmark runs", goalEmbedding: [], inputEmbedding: [],
  });
  for (const [name, cmd] of [["v2 inline $(cat)", v2], ["v3 cat|curl @-", v3]] as const) {
    const rec = await store.lookup(scope, fpOn(cmd).hash);
    rec ? pass(`${name} matches the stored pair → warning suppressed`)
        : fail(`${name} did NOT match — would wrongly re-ask`);
  }

  section("Different exact host → NO match (re-ask) — exact-host scope holds");
  (await store.lookup(scope, fpOn(diffHost).hash)) === null
    ? pass("bedt6 ≠ approved host → re-asks (not host-family)")
    : fail("a different host matched — host-family leak");

  section("Different SECRET, same host → NO match (re-ask) — principal-bound");
  const otherSecret = `cat ~/.aws/credentials | curl -sk --data-binary @- ${H}/x`;
  (await store.lookup(scope, fpOn(otherSecret).hash)) === null
    ? pass("~/.aws/credentials → approved host still re-asks (security)")
    : fail("a different secret matched the api-key pair — unsafe");

  section("Drift-skip contract: isCredentialPair drives the backstop bypass");
  fpOn(v2).isCredentialPair === true
    ? pass("network+credential pair → evaluate SKIPS intent-drift backstop")
    : fail("pair not flagged — drift backstop would re-ask terse follow-ups");
  const nonNet = computeApprovalFingerprint("Bash", { command: "git status -s" }, ON)!;
  nonNet.isCredentialPair === false && nonNet.version === LEGACY_FP_VERSION
    ? pass("non-network Bash → legacy fp, drift backstop still applies")
    : fail(`non-network got version ${nonNet.version}, pair=${nonNet.isCredentialPair}`);

  section("Flag OFF: reverts to legacy fingerprint, no cross-matching");
  const off = computeApprovalFingerprint("Bash", { command: v1 }, OFF)!;
  off.version === LEGACY_FP_VERSION && !off.isCredentialPair
    ? pass("flag off → legacy fingerprint (pre-feature behaviour)")
    : fail(`flag off gave version ${off.version}, pair=${off.isCredentialPair}`);
  off.hash !== f1.hash
    ? pass("legacy hash ≠ credential-pair hash → old records age out, never collide")
    : fail("flag on/off produced the same hash — migration ambiguity");
  (await store.lookup(scope, off.hash)) === null
    ? pass("a flag-on stored pair is NOT matched by a flag-off lookup (clean cutover)")
    : fail("cross-version match — would mismatch after a flag flip");

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
