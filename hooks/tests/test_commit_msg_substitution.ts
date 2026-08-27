/**
 * Regression test for the git-commit-message substitution safety check.
 *
 * The check rejects unsafe shell substitutions (`$(...)`, backticks) in
 * commit message bodies because they execute at shell expansion time —
 * BEFORE git ever sees the message. Genuine threats: an attacker who
 * gets to influence the commit message body could run arbitrary code.
 *
 * The false positive we're guarding against (session 455e88d2,
 * 2026-05-23): a long commit message written with the canonical
 * heredoc pattern `git commit -m "$(cat <<'EOF' ... EOF)"`. When the
 * heredoc tag is QUOTED (`<<'EOF'`), the shell does NOT expand the
 * body — `$()` and backticks inside are literal text, typically used
 * as markdown-style inline code formatting. The pre-fix extractor
 * stripped the inner backticks AS IF they were substitutions and the
 * commit was rejected.
 *
 * Run: npx tsx hooks/tests/test_commit_msg_substitution.ts
 */

import { evaluateToolPolicy } from "../../src/tool-policy.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const pass = (m: string) => { console.log(`  ${c.green}✓${c.off} ${m}`); PASS++; };
const fail = (m: string) => { console.log(`  ${c.red}✗${c.off} ${m}`); FAIL++; };
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

function expectAllow(label: string, command: string): void {
  const r = evaluateToolPolicy("Bash", { command });
  if (r.decision === "deny") {
    fail(`${label}: expected allow/review, got deny — ${r.reason}`);
  } else {
    pass(`${label} (decision=${r.decision})`);
  }
}

function expectDeny(label: string, command: string, expectedSubstr?: string): void {
  const r = evaluateToolPolicy("Bash", { command });
  if (r.decision !== "deny") {
    fail(`${label}: expected deny, got ${r.decision}`);
    return;
  }
  if (expectedSubstr && !r.reason.includes(expectedSubstr)) {
    fail(`${label}: deny reason missing "${expectedSubstr}" — got "${r.reason}"`);
    return;
  }
  pass(`${label} (denied: "${r.reason.substring(0, 80)}…")`);
}

function main() {
  section("Quoted-heredoc commit messages — markdown backticks inside are literal");

  // The exact shape that false-positived on 455e88d2: long commit message
  // with markdown code formatting around tool names.
  expectAllow(
    "commit -m \"$(cat <<'EOF' ... `npx tsx` ... EOF)\"",
    `git commit -m "$(cat <<'EOF'
This was previously run via \`npx tsx\` against the harness.
EOF
)"`,
  );

  expectAllow(
    "commit -m with backticks inside <<'EOF' (aws CLI mention)",
    `git commit -m "$(cat <<'EOF'
Replaced shell-out to \`aws bedrock-runtime converse\` with the SDK.
EOF
)"`,
  );

  expectAllow(
    "commit -m with \$(...) inside <<'EOF' (literal text)",
    `git commit -m "$(cat <<'EOF'
Note: \$(whoami) is now resolved via the SDK identity helper.
EOF
)"`,
  );

  expectAllow(
    "double-quoted heredoc tag also disables expansion",
    `git commit -m "$(cat <<"EOF"
Some prose with \`backticks\` inside.
EOF
)"`,
  );

  expectAllow(
    "tag heredoc with backticks in body",
    `git tag -m "$(cat <<'MSG'
v1.0.0 release. Notes: see \`docs/\` for details.
MSG
)" v1.0.0`,
  );

  // -------------------------------------------------------------------
  section("Unsafe substitutions still rejected");

  // Naked backtick in -m "..." (no heredoc) — backtick IS a substitution.
  // Use `printenv` (not allowlisted) rather than `whoami` (allowlisted).
  expectDeny(
    "commit -m with naked backtick substitution",
    'git commit -m "release `printenv | head -1`"',
    "command substitution",
  );

  // Unquoted heredoc tag — shell DOES expand body. Backticks are real
  // substitutions here.
  expectDeny(
    "commit -m \"$(cat <<EOF ... `rm -rf /` ... EOF)\" (unquoted tag)",
    `git commit -m "$(cat <<EOF
broke things \`rm -rf /\` lol
EOF
)"`,
    "command substitution",
  );

  // $() inside -m that isn't a safe allowlisted form.
  expectDeny(
    "commit -m \"$(cat .env)\"",
    'git commit -m "$(cat .env)"',
    "command substitution",
  );

  // -------------------------------------------------------------------
  section("Safe substitution allowlist still works");

  expectAllow(
    "commit -m with safe $(date +%Y-%m-%d)",
    'git commit -m "release $(date +%Y-%m-%d)"',
  );

  expectAllow(
    "commit -m with safe $(git rev-parse --short HEAD)",
    'git commit -m "deploy $(git rev-parse --short HEAD)"',
  );

  // -------------------------------------------------------------------
  section("Inert substitution text is not a substitution (2026-08-27 prod FP)");

  // Backslash-escaped `\$(` in a double-quoted message is a LITERAL
  // dollar — the shell never executes it. This repo's own commit
  // messages document patterns like `$(cat P)` and were denied for it.
  expectAllow(
    'commit -m "docs \\$(cat P) pattern" (escaped, inert)',
    'git commit -m "recognise the \\$(cat P) read shape"',
  );

  // Escaped backticks are literal characters too.
  expectAllow(
    'commit -m with escaped backticks',
    'git commit -m "run \\`npx tsx\\` first"',
  );

  // Single-quoted message: the shell expands NOTHING inside single
  // quotes — $() and backticks there are prose.
  expectAllow(
    "commit -m '...$(cat P)...' (single-quoted, inert)",
    "git commit -m 'documents the $(cat P) and `cat X` shapes'",
  );

  // Double backslash = literal backslash, then a LIVE substitution:
  // `\\$(cmd)` must still be caught.
  expectDeny(
    'commit -m "\\\\$(cat .env)" (double backslash → live)',
    'git commit -m "payload \\\\$(cat .env)"',
    "command substitution",
  );

  // Escaped \$ inside an unquoted-tag heredoc is literal there too.
  expectAllow(
    "heredoc body with escaped \\$( (inert)",
    `git commit -F - <<EOF
documents the \\$(cat P) shape
EOF`,
  );

  // -------------------------------------------------------------------
  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
