/**
 * Nested shell-variable expansion when resolving a curl target host.
 *
 * `expandLiteral` did a SINGLE replace pass, so a URL held in one variable
 * that itself references another never fully resolved:
 *
 *   REGION=eu-west-1
 *   URL="https://27tmjax9wd.execute-api.$REGION.amazonaws.com/default/x"
 *   curl -s -X POST "$URL" -H "x-api-key: $KEY" ...
 *
 * `$URL` expanded to a string still containing `$REGION`, `hostOf()` rejected
 * it as an invalid URL, and the whole fingerprint came back null — so the
 * (principal, host) consent pair could not be formed and the user was re-asked
 * every time. Measured over 625 denied Bash commands since 2026-07-01: of the
 * 71 that both reach the network AND carry a credential, 55 (77%) failed to
 * produce a consent key, and multi-line commands of this shape were 80% of
 * those misses.
 *
 * Two directions matter and they pull opposite ways:
 *   - resolve MORE hosts, so approving once actually suppresses the re-ask;
 *   - never invent a host. An unresolvable variable must yield null (re-ask),
 *     never a half-expanded string. Two live prod approvals were stored
 *     against `bedrock-runtime.$r.amazonaws.com` — a host that does not exist,
 *     keying an approval that can never legitimately match again.
 *
 * Run: npx tsx hooks/tests/test_credential_url_expansion.ts
 */

import { fingerprintNetwork } from "../../src/credential-flow.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m", dim: "\x1b[2m" };
let PASS = 0;
let FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++) : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

const hostOf = (cmd: string): string | null => (fingerprintNetwork(cmd) as any)?.shape?.host ?? null;
const principalsOf = (cmd: string): string[] => (fingerprintNetwork(cmd) as any)?.shape?.principals ?? [];

function main() {
  section("baseline — these already worked and must keep working");
  ok(
    "literal URL inline",
    hostOf('curl -H "Authorization: Bearer $(cat ~/.k)" https://dredd-hook.acta.io/api/health') ===
      "dredd-hook.acta.io",
  );
  ok(
    "single-level variable",
    hostOf('URL="https://api.example.com/v1"; curl -s -H "x-api-key: $(cat k.txt)" "$URL"') === "api.example.com",
  );

  section("nested expansion — the real production shape");
  const real =
    'cd /Users/adrian/IdeaProjects/YourTrainer\n' +
    'REGION=eu-west-1\n' +
    'URL="https://27tmjax9wd.execute-api.$REGION.amazonaws.com/default/ytExerciseAdvisor"\n' +
    'KEY=$(cat api.key)\n' +
    'curl -s -X POST "$URL" -H "x-api-key: $KEY" -H "content-type: application/json"';
  ok("nested $REGION inside $URL resolves", hostOf(real) === "27tmjax9wd.execute-api.eu-west-1.amazonaws.com");
  ok("...and the principal is still resolved", principalsOf(real).includes("file:api.key"));

  ok(
    "braced ${REGION} form",
    hostOf('REGION=eu-west-1; URL="https://svc.${REGION}.amazonaws.com/x"; curl -H "x-api-key: $(cat k)" "$URL"') ===
      "svc.eu-west-1.amazonaws.com",
  );
  ok(
    "two levels of indirection",
    hostOf('R=eu-west-1; H="api.$R.example.com"; U="https://$H/v1"; curl -H "x-api-key: $(cat k)" "$U"') ===
      "api.eu-west-1.example.com",
  );

  section("never invent a host — unresolvable stays null (fail safe)");
  ok(
    "undefined variable in host yields NO host, not a half-expanded one",
    hostOf('curl -s -H "x-api-key: $(cat k)" "https://bedrock-runtime.$r.amazonaws.com/invoke"') === null,
  );
  ok(
    "undefined variable via an assigned URL also yields null",
    hostOf('URL="https://svc.$UNSET_REGION.amazonaws.com/x"; curl -H "x-api-key: $(cat k)" "$URL"') === null,
  );

  section("an unresolved var in the PATH is harmless — host is still known");
  // Regression: a `for MID in …` loop variable in the path made the whole URL
  // get rejected, losing a fingerprint whose host was never in doubt.
  ok(
    "loop variable in the path still yields the host",
    hostOf(
      // Verbatim shape from the denied production command: the curl begins a
      // statement (after `do echo …;`), so argv[0] is `curl`. A curl placed
      // immediately after `do` is a separate, out-of-scope tokenizer gap.
      'export TOK=$(cat bedrock.key) && for MID in a b; do echo "=== $MID ==="; curl -s -X POST ' +
        '"https://bedrock-runtime.eu-central-1.amazonaws.com/model/$MID/converse" ' +
        '-H "Authorization: Bearer $TOK"; done',
    ) === "bedrock-runtime.eu-central-1.amazonaws.com",
  );
  ok(
    "unresolved var in the QUERY string is likewise harmless",
    hostOf('curl -H "x-api-key: $(cat k)" "https://api.example.com/v1?run=$RUN_ID"') === "api.example.com",
  );

  section("termination — a cycle must not hang or blow the stack");
  ok("self-reference terminates", hostOf('A="$A"; URL="https://$A.example.com"; curl "$URL"') === null);
  ok(
    "mutual reference terminates",
    hostOf('A="$B"; B="$A"; URL="https://$A.example.com"; curl -H "x-api-key: $(cat k)" "$URL"') === null,
  );

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
