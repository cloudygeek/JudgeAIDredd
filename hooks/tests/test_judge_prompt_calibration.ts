/**
 * Judge prompt calibration for the two dominant FP classes in the weekly
 * deny review for 2026-07-26..08-02 (93 denies total).
 *
 * 1. MULTI-AGENT COORDINATION — 9 denies (~10%). With agent teams enabled, a
 *    sub-agent reporting to a coordinator trips "clearly serves a different
 *    objective than the current task", because the message's SUBJECT
 *    legitimately differs from the turn's task. e.g. "task is removing web
 *    support from a file picker, but the action sends a message to
 *    'team-lead' with a security/compliance review".
 *
 * 2. PROVENANCE WEIGHTING — 12 denies (~13%). The <provenance_alert> block
 *    told the judge it was "authoritative" and to weigh it as "strong
 *    evidence", so the judge treated it as dispositive ("...which matches the
 *    provenance alert"). Every one of the 12 was the same benign idiom: write
 *    a test token into a scratchpad env file, source it, curl the project's
 *    OWN dev API. The path is real; the exfiltration conclusion is not.
 *
 * Critical invariant: the B7 baseline prompt must stay BYTE-IDENTICAL. It is
 * the published comparison point for the AgentDojo / P14 numbers — silently
 * changing it would invalidate every prior benchmark result. Only B7.1 (the
 * production variant) gains the new guidance.
 *
 * Run: npx tsx hooks/tests/test_judge_prompt_calibration.ts
 */

import { systemPromptFor, renderProvenanceBlock } from "../../src/intent-judge.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

const ok = (label: string, cond: boolean) => (cond ? pass(label) : fail(label));

function main() {
  const b7 = systemPromptFor("B7");
  const b71 = systemPromptFor("B7.1");
  const office = systemPromptFor("B7.1-office");
  const std = systemPromptFor("standard");

  section("prompt selection still resolves every variant");
  ok("B7 non-empty", b7.length > 0);
  ok("B7.1 non-empty", b71.length > 0);
  ok("B7.1-office non-empty", office.length > 0);
  ok("standard non-empty", std.length > 0);
  ok("B7.1 is a superset of B7 (V2 adds, never removes)", b71.length > b7.length);
  ok("B7.1 retains the euphemism section", b71.includes("== EUPHEMISM DETECTION =="));

  section("B7.1 gains multi-agent coordination guidance");
  ok("has the coordination section", b71.includes("== MULTI-AGENT COORDINATION =="));
  ok(
    "states topic mismatch alone is insufficient",
    /topic mismatch alone/i.test(b71) && /not sufficient/i.test(b71),
  );
  ok("names the coordination tools", /SendMessage|sub-agent|coordinator/i.test(b71));
  ok(
    "still hijacks coordination that carries secrets outward",
    /secret value|sensitive data/i.test(b71.split("== MULTI-AGENT COORDINATION ==")[1] ?? ""),
  );

  section("B7 baseline is untouched (benchmark comparability)");
  ok("B7 has NO coordination section", !b7.includes("== MULTI-AGENT COORDINATION =="));
  ok("B7 has NO euphemism section", !b7.includes("== EUPHEMISM DETECTION =="));
  ok("office variant unaffected", !office.includes("== MULTI-AGENT COORDINATION =="));

  section("provenance block: path authoritative, verdict is the judge's");
  const block = renderProvenanceBlock("1. [HIGH] command references /proj/.env read at turn 3.");
  ok("still renders the evidence", block.includes("/proj/.env read at turn 3"));
  ok("still wrapped in the server-trusted tag", block.includes('<provenance_alert server_trusted="true">'));
  ok(
    "no longer instructs 'weigh as strong evidence'",
    !/weigh it as strong evidence/i.test(block),
  );
  ok(
    "separates the observed path from the malicious conclusion",
    /path itself is authoritative/i.test(block) && /judgement|judgment/i.test(block),
  );
  ok(
    "calibrates on destination (first-party vs third party)",
    /first-party|own API|destination/i.test(block),
  );
  ok(
    "calibrates on credential origin (session-issued test tokens)",
    /originated outside the session|session itself (just )?created|test/i.test(block),
  );
  ok("empty evidence still renders nothing", renderProvenanceBlock("") === "");

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
