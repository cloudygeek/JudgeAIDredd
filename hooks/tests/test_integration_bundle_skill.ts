/**
 * Integration bundle: confirm the working-with-dredd-judge skill is
 * included in the zip and the canonical file is in the repo (so the
 * Dockerfile's COPY skills/ picks it up at image-build time).
 *
 * Run: npx tsx hooks/tests/test_integration_bundle_skill.ts
 */

import { buildIntegrationBundle } from "../../src/integration-bundle.js";
import { existsSync } from "node:fs";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

section("canonical skill present in repo");
existsSync("skills/working-with-dredd-judge/SKILL.md")
  ? pass("skills/working-with-dredd-judge/SKILL.md exists")
  : fail("missing canonical skill — Dockerfile COPY will have nothing to copy");

section("buildIntegrationBundle includes the skill entry");
{
  const buf = buildIntegrationBundle("https://example.com");
  const ENTRY = "skills/working-with-dredd-judge/SKILL.md";
  // ZIP local-file headers + central-directory records carry the entry
  // name uncompressed, so a substring match against the buffer is a
  // reliable check that the file was bundled (and the fail-soft branch
  // wasn't taken).
  buf.includes(ENTRY)
    ? pass(`zip contains entry name ${ENTRY}`)
    : fail("entry name not found in zip — readSkillEntrySafe likely returned null");
  buf.length > 2000
    ? pass(`bundle non-trivial size (${buf.length} bytes)`)
    : fail(`bundle suspiciously small: ${buf.length} bytes`);
}

console.log(`\n  ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
