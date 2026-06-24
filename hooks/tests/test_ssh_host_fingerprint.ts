/**
 * Host-pinned approval fingerprints for remote-exec verbs (ssh/scp/rsync).
 *
 * Fixes the FP where a user repeatedly approves an ssh and it keeps getting
 * re-judged hijacked: ssh fell through to the generic Bash fingerprint
 * (`argv.slice(0,3)` = "ssh -o StrictHostKeyChecking=no" — HOST-BLIND), which
 * the intent-drift backstop then rejected on topic-shifting sessions. curl/wget
 * already get a host-pinned `(host, …)` fingerprint via fingerprintNetwork and
 * are exempt from the drift backstop (handlers/evaluate.ts:364 `!isCredentialPair`).
 *
 * This extends fingerprintNetwork to pin ssh/scp/rsync to (verb, host, full-cmd).
 * Full-command (not host-only) is deliberate: exempting host-only would let an
 * injection run a DIFFERENT command on an approved host while still drift-exempt.
 * Pinning the command means only the exact approved (host, command) is exempt;
 * a different host OR remote command yields a different hash → re-checked.
 *
 * Run: npx tsx hooks/tests/test_ssh_host_fingerprint.ts
 */

import { fingerprintNetwork } from "../../src/credential-flow.js";
import { computeApprovalFingerprint } from "../../src/approval-fingerprint.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
function check<T>(label: string, fn: () => T, ok: (v: T) => boolean): void {
  try { const v = fn(); ok(v) ? pass(label) : fail(`${label} (got ${JSON.stringify(v)})`); }
  catch (e: any) { fail(`${label} (threw: ${e?.message})`); }
}
const host = (cmd: string) => (fingerprintNetwork(cmd)?.shape as { host?: string } | undefined)?.host;
const hash = (cmd: string) => fingerprintNetwork(cmd)?.hash;

const SSH = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 172.16.0.99 'bash -lc "cd /tmp; pip install -U mlx-lm"'`;

console.log("\n--- ssh host-pinned fingerprint ---");
check("ssh command produces a fingerprint", () => fingerprintNetwork(SSH), (v) => v !== null);
check("ssh host extracted past -o flags = 172.16.0.99", () => host(SSH), (v) => v === "172.16.0.99");
check("ssh summary mentions 'ssh to <host>'", () => fingerprintNetwork(SSH)?.summary, (v) => /ssh to 172\.16\.0\.99/.test(String(v)));
check("ssh user@host extracts host", () => host("ssh deploy@build.example.com uptime"), (v) => v === "build.example.com");
check("bare 'ssh -V' (no host) → null (falls through to generic)", () => fingerprintNetwork("ssh -V"), (v) => v === null);

console.log("\n--- stability & security boundaries ---");
check("identical ssh → identical hash (so repeats match → drift-exempt)", () => hash(SSH) && hash(SSH) === hash(SSH), (v) => v === true);
check("different HOST → different hash (hijack to another host re-asks)",
  () => hash(SSH) !== hash(SSH.replace("172.16.0.99", "10.0.0.5")), (v) => v === true);
check("same host, DIFFERENT remote command → different hash (approved-host/attacker-cmd not exempt)",
  () => hash(SSH) !== hash(`ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 172.16.0.99 'rm -rf /'`), (v) => v === true);

console.log("\n--- scp / rsync ---");
check("scp host:path extracts host", () => host("scp -P 2222 ./file.txt user@store.example.com:/tmp/"), (v) => v === "store.example.com");
check("rsync user@host:path extracts host", () => host("rsync -av ./dist/ deploy@web.example.com:/var/www/"), (v) => v === "web.example.com");

console.log("\n--- integration + regressions ---");
check("computeApprovalFingerprint(ssh) → isCredentialPair=true (drift-exempt)",
  () => computeApprovalFingerprint("Bash", { command: SSH }, { credentialConsent: true })?.isCredentialPair, (v) => v === true);
check("non-network bash (ls) → NOT host-pinned (isCredentialPair=false)",
  () => computeApprovalFingerprint("Bash", { command: "ls -la /tmp" }, { credentialConsent: true })?.isCredentialPair, (v) => v === false);
check("curl still host-pinned (regression)", () => host("curl https://api.example.com/x"), (v) => v === "api.example.com");

console.log(`\n${FAIL === 0 ? c.green + "ALL PASS" : c.red + FAIL + " FAILED"}${c.off}  (${PASS} passed, ${FAIL} failed)\n`);
process.exit(FAIL === 0 ? 0 : 1);
