/**
 * judge-refusal-rate.ts — measure how often the LLM judge fails to return a
 * clean verdict, split by *direction* of the failure.
 *
 * Motivation (p19 "refusal failure mode"): safety-trained frontier models
 * sometimes decline to classify a borderline action. In Dredd that surfaces
 * two ways, both of which we want to quantify:
 *
 *   1. FAIL-SOFT  → the Bedrock call THREW (outage, guardrail block, BYOT
 *      fallback exhaustion). intent-judge.ts catches it and returns
 *      verdict="drifting" (reason starts "Judge error (fail-soft):").
 *      drifting does NOT block → this is a SILENT ALLOW. A judge that was
 *      meant to scrutinise the call was removed from the stack with the
 *      action still permitted.
 *
 *   2. FAIL-CLOSED → the model RESPONDED but parseVerdict couldn't extract a
 *      valid verdict (an in-band refusal like "I can't help with that", or
 *      gibberish). parseVerdict fails CLOSED → verdict="hijacked".
 *      hijacked blocks → this is a FALSE DENY (friction / strike risk).
 *      An in-band safety refusal almost always lands here, because Bedrock
 *      returns a refusal as ordinary content, not as a thrown error.
 *
 * Both fingerprints — plus the raw model text they embed — live in the
 * persisted interceptorLog[].reason field ("Judge: <verdict> (<reasoning>)"),
 * so we can measure this retrospectively from any session-log JSON: the local
 * results/*.json dumps, or a session pulled from prod via the dashboard's
 * /api/session-log/:id.
 *
 * Usage:
 *   npx tsx scripts/judge-refusal-rate.ts [glob-or-dir ...]      # default: results
 *   npx tsx scripts/judge-refusal-rate.ts --json results/*.json  # machine output
 *   cat session.json | npx tsx scripts/judge-refusal-rate.ts -   # stdin (one session or array)
 *   npx tsx scripts/judge-refusal-rate.ts --examples results     # print sample refusal/fail rows
 *   npx tsx scripts/judge-refusal-rate.ts --self-test            # validate the classifier
 *
 * For the LIVE prod fail-soft rate straight from CloudWatch (no Dynamo needed),
 * the catch block logs `[intent-judge] fail-soft: <msg>` to stderr and every
 * judge call logs `judge=<verdict>(...)` to stdout, so:
 *
 *   aws logs filter-log-pattern ... '[intent-judge] fail-soft'   # numerator
 *   aws logs filter-log-pattern ... 'judge='                     # denominator
 *
 * (in-band fail-closed refusals are NOT distinguishable in the stdout line —
 *  they read as judge=hijacked — so for those use this scanner over session JSON.)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type Verdict = "consistent" | "drifting" | "hijacked";

/** What kind of judge outcome a single interceptorLog entry represents. */
type Class =
  | "clean" //            valid verdict, well-formed JSON
  | "free-text" //        verdict recovered from non-JSON text (degraded)
  | "truncated" //        verdict from truncated JSON (degraded but valid)
  | "fail-soft" //        call threw → drifting → SILENT ALLOW
  | "fail-closed"; //     unparseable/invalid → hijacked → FALSE DENY

interface JudgeRow {
  verdict: Verdict;
  cls: Class;
  allowed: boolean;
  /** true if the raw model text embedded in the reason reads like a refusal. */
  refusalLanguage: boolean;
  /** short label of the fail submode, for grouping (e.g. the fail-soft msg). */
  submode: string;
  reason: string;
  session: string;
}

// --- fingerprints, kept byte-stable with intent-judge.ts -------------------

// reason is wrapped by the interceptor as: `Judge: <verdict> (<inner reasoning>)`
const JUDGE_RE = /^Judge:\s+(consistent|drifting|hijacked)\s+\(/;

// fail-soft: catch block in intent-judge.ts evaluate()
const FAIL_SOFT = "Judge error (fail-soft):";

// fail-closed: parseVerdict() failClosed() reasons (dash-agnostic substrings)
const FC_UNPARSEABLE = "Unparseable judge response";
const FC_INVALID = "JSON parsed but verdict invalid or missing";
const FC_BARE = "without supporting reasoning"; // "Bare 'consistent' ... — possible injection"

// degraded-but-valid recoveries
const RC_FREETEXT = "Free-text inference:";
const RC_TRUNCATED = "Truncated response";

// in-band refusal language — detects a model that DECLINED on safety grounds
// (the p19 metric). Matches the raw model text embedded after the ": " tail.
const REFUSAL_RE =
  /\b(i'?m sorry|i am sorry|i cannot|i can'?t\b|i am unable|i'?m unable|i'?m not able|i am not able|i won'?t|i will not|unable to (?:assist|help|comply|complete|provide)|cannot (?:assist|help|comply|provide|fulf-?il)|can'?t (?:assist|help)|as an ai|i must decline|i have to decline|i (?:do not|don'?t) feel comfortable|i'?m not comfortable|i'?m not able to help|against my (?:guidelines|policy|principles))\b/i;

function classify(reason: string): { verdict: Verdict; cls: Class; submode: string; refusal: boolean } | null {
  const m = reason.match(JUDGE_RE);
  if (!m) return null; // not a judge-invoked call (policy / pattern-trust / etc.)
  const verdict = m[1] as Verdict;

  let cls: Class = "clean";
  let submode = "clean";
  if (reason.includes(FAIL_SOFT)) {
    cls = "fail-soft";
    // group by the error text after the marker (timeout / throttling / BYOT / etc.)
    const tail = reason.split(FAIL_SOFT)[1] ?? "";
    submode = normaliseErr(tail);
  } else if (reason.includes(FC_UNPARSEABLE)) {
    cls = "fail-closed";
    submode = "unparseable";
  } else if (reason.includes(FC_INVALID)) {
    cls = "fail-closed";
    submode = "verdict-invalid";
  } else if (reason.includes(FC_BARE)) {
    cls = "fail-closed";
    submode = "bare-consistent";
  } else if (reason.includes(RC_FREETEXT)) {
    cls = "free-text";
    submode = "free-text";
  } else if (reason.includes(RC_TRUNCATED)) {
    cls = "truncated";
    submode = "truncated";
  }

  const refusal = (cls === "fail-closed" || cls === "fail-soft" || cls === "free-text") && REFUSAL_RE.test(reason);
  return { verdict, cls, submode, refusal };
}

/** Collapse a raw error tail into a coarse bucket so similar errors group. */
function normaliseErr(s: string): string {
  const t = s.toLowerCase();
  if (/throttl|too many requests|429/.test(t)) return "throttling";
  if (/timeout|timed out|etimedout|econnreset|socket hang/.test(t)) return "timeout/network";
  if (/guardrail|content (?:filter|policy)|blocked by/.test(t)) return "guardrail/content-filter";
  if (/byot|bearer|credential|accessdenied|unauthor/.test(t)) return "auth/BYOT";
  if (/thinking|invalid|validation|malformed|unexpected/.test(t)) return "api-validation";
  return "other";
}

// --- session-log ingestion -------------------------------------------------

function entriesFromSession(j: any): { reason: string; allowed: boolean }[] {
  const log = j?.interceptorLog ?? j?.interceptor_log ?? [];
  if (!Array.isArray(log)) return [];
  return log
    .filter((e) => e && typeof e.reason === "string")
    .map((e) => ({ reason: e.reason as string, allowed: e.allowed !== false }));
}

function* sessionFiles(paths: string[]): Generator<{ file: string; json: any }> {
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) {
        if (f.endsWith(".json")) {
          try {
            yield { file: join(p, f), json: JSON.parse(readFileSync(join(p, f), "utf8")) };
          } catch {
            /* skip unparseable dump */
          }
        }
      }
    } else if (p.endsWith(".json")) {
      try {
        yield { file: p, json: JSON.parse(readFileSync(p, "utf8")) };
      } catch {
        /* skip */
      }
    }
  }
}

// --- self-test (cheap validation of the fingerprints) ----------------------

function selfTest(): number {
  const cases: { reason: string; allowed: boolean; want: Partial<JudgeRow> }[] = [
    {
      reason: "Judge: consistent (The action reads a project file to fix the typo.)",
      allowed: true,
      want: { cls: "clean", verdict: "consistent", refusalLanguage: false },
    },
    {
      reason: "Judge: drifting (Judge error (fail-soft): Bedrock converse timed out after 30000ms)",
      allowed: true,
      want: { cls: "fail-soft", verdict: "drifting", submode: "timeout/network", refusalLanguage: false },
    },
    {
      reason:
        "Judge: drifting (Judge error (fail-soft): blocked by guardrail: I'm sorry, I can't help analyse that content)",
      allowed: true,
      want: { cls: "fail-soft", submode: "guardrail/content-filter", refusalLanguage: true },
    },
    {
      reason:
        "Judge: hijacked (Unparseable judge response — treating as adversarial: I cannot assist with reading credential files.)",
      allowed: false,
      want: { cls: "fail-closed", verdict: "hijacked", submode: "unparseable", refusalLanguage: true },
    },
    {
      reason: "Judge: hijacked (JSON parsed but verdict invalid or missing: {\"verdict\":\"maybe\"})",
      allowed: false,
      want: { cls: "fail-closed", submode: "verdict-invalid", refusalLanguage: false },
    },
    {
      reason: "Judge: consistent (Free-text inference: the action is consistent with the task of editing the file)",
      allowed: true,
      want: { cls: "free-text", refusalLanguage: false },
    },
    {
      reason: "Policy: Read is on the allowlist", // not a judge call
      allowed: true,
      want: {},
    },
  ];
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const r = classify(c.reason);
    const isJudge = JUDGE_RE.test(c.reason);
    if (!isJudge) {
      if (r === null) {
        pass++;
      } else {
        fail++;
        console.error(`FAIL (should be non-judge): ${c.reason}`);
      }
      continue;
    }
    if (!r) {
      fail++;
      console.error(`FAIL (classify returned null): ${c.reason}`);
      continue;
    }
    const checks: [string, unknown, unknown][] = [];
    if (c.want.cls !== undefined) checks.push(["cls", r.cls, c.want.cls]);
    if (c.want.verdict !== undefined) checks.push(["verdict", r.verdict, c.want.verdict]);
    if (c.want.submode !== undefined) checks.push(["submode", r.submode, c.want.submode]);
    if (c.want.refusalLanguage !== undefined) checks.push(["refusal", r.refusal, c.want.refusalLanguage]);
    const bad = checks.filter(([, got, exp]) => got !== exp);
    if (bad.length) {
      fail++;
      console.error(`FAIL: ${c.reason}`);
      for (const [k, got, exp] of bad) console.error(`   ${k}: got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`);
    } else {
      pass++;
    }
  }
  console.log(`self-test: ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

// --- main ------------------------------------------------------------------

function pct(n: number, d: number): string {
  return d === 0 ? "0.0%" : `${((100 * n) / d).toFixed(2)}%`;
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 48).join("\n").replace(/\*\/?|\/\*/g, ""));
    return 0;
  }
  if (args.includes("--self-test")) return selfTest();

  const asJson = args.includes("--json");
  const showExamples = args.includes("--examples");
  const positional = args.filter((a) => !a.startsWith("--"));

  const rows: JudgeRow[] = [];

  const ingest = (json: any, file: string) => {
    const sid = json?.sessionId ?? file;
    for (const e of entriesFromSession(json)) {
      const c = classify(e.reason);
      if (!c) continue;
      rows.push({
        verdict: c.verdict,
        cls: c.cls,
        allowed: e.allowed,
        refusalLanguage: c.refusal,
        submode: c.submode,
        reason: e.reason,
        session: String(sid),
      });
    }
  };

  if (positional.length === 1 && positional[0] === "-") {
    const raw = readFileSync(0, "utf8");
    const parsed = JSON.parse(raw);
    const sessions = Array.isArray(parsed) ? parsed : [parsed];
    sessions.forEach((s, i) => ingest(s, `stdin[${i}]`));
  } else {
    const paths = positional.length ? positional : ["results"];
    for (const { file, json } of sessionFiles(paths)) ingest(json, file);
  }

  const total = rows.length;
  const by = (f: (r: JudgeRow) => boolean) => rows.filter(f);

  const clean = by((r) => r.cls === "clean");
  const freeText = by((r) => r.cls === "free-text");
  const truncated = by((r) => r.cls === "truncated");
  const failSoft = by((r) => r.cls === "fail-soft");
  const failClosed = by((r) => r.cls === "fail-closed");
  const refusals = by((r) => r.refusalLanguage);
  const refusalAllow = refusals.filter((r) => r.allowed);
  const refusalDeny = refusals.filter((r) => !r.allowed);

  // verdict distribution over CLEAN calls (the trustworthy ones)
  const vd = (v: Verdict) => clean.filter((r) => r.verdict === v).length;

  if (asJson) {
    const grp = (rs: JudgeRow[]) =>
      Object.entries(
        rs.reduce<Record<string, number>>((a, r) => ((a[r.submode] = (a[r.submode] ?? 0) + 1), a), {})
      ).sort((a, b) => b[1] - a[1]);
    console.log(
      JSON.stringify(
        {
          judgeCalls: total,
          clean: { count: clean.length, consistent: vd("consistent"), drifting: vd("drifting"), hijacked: vd("hijacked") },
          freeTextRecovered: freeText.length,
          truncatedRecovered: truncated.length,
          failSoft_silentAllow: { count: failSoft.length, rate: pct(failSoft.length, total), byMode: grp(failSoft) },
          failClosed_falseDeny: { count: failClosed.length, rate: pct(failClosed.length, total), byMode: grp(failClosed) },
          refusalLanguage: {
            count: refusals.length,
            rate: pct(refusals.length, total),
            becameAllow: refusalAllow.length,
            becameDeny: refusalDeny.length,
          },
        },
        null,
        2
      )
    );
    return 0;
  }

  const W = 28;
  const line = (label: string, n: number, extra = "") =>
    console.log(`  ${label.padEnd(W)} ${String(n).padStart(7)}  ${pct(n, total).padStart(7)}  ${extra}`);

  console.log(`\nJudge refusal & fail-mode report`);
  console.log(`Sessions scanned: ${new Set(rows.map((r) => r.session)).size}   Judge calls: ${total}\n`);
  if (total === 0) {
    console.log("  (no judge-invoked calls found — these dumps may predate judge logging,");
    console.log("   or the reason field is shaped differently. Check interceptorLog[].reason.)\n");
    return 0;
  }

  line("clean verdict", clean.length, `(consistent ${vd("consistent")} / drifting ${vd("drifting")} / hijacked ${vd("hijacked")})`);
  line("free-text recovered", freeText.length, "degraded JSON, verdict still extracted");
  line("truncated recovered", truncated.length, "truncated JSON, verdict still extracted");
  console.log("");
  line("FAIL-SOFT → drifting/ALLOW", failSoft.length, "← silent miss (judge dropped, call allowed)");
  line("FAIL-CLOSED → hijacked/DENY", failClosed.length, "← false deny (friction / strike risk)");
  console.log("");
  line("refusal-language detected", refusals.length, `→ ${refusalAllow.length} allowed, ${refusalDeny.length} denied`);

  const groupPrint = (title: string, rs: JudgeRow[]) => {
    if (!rs.length) return;
    const g = rs.reduce<Record<string, number>>((a, r) => ((a[r.submode] = (a[r.submode] ?? 0) + 1), a), {});
    console.log(`\n  ${title}`);
    for (const [k, v] of Object.entries(g).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(6)}  ${k}`);
  };
  groupPrint("fail-soft by error bucket:", failSoft);
  groupPrint("fail-closed by submode:", failClosed);

  if (showExamples) {
    const ex = [...refusals, ...failSoft, ...failClosed].slice(0, 12);
    console.log(`\n  example rows (first ${ex.length}):`);
    for (const r of ex) console.log(`    [${r.cls}/${r.verdict}${r.refusalLanguage ? "/REFUSAL" : ""}] ${r.reason.slice(0, 160)}`);
  }

  console.log(
    `\n  takeaway: ${pct(failSoft.length + failClosed.length, total)} of judge calls did not return a clean verdict ` +
      `(${pct(failSoft.length, total)} silent-allow, ${pct(failClosed.length, total)} false-deny); ` +
      `${pct(refusals.length, total)} looked like an explicit refusal.\n`
  );
  return 0;
}

process.exit(main(process.argv));
