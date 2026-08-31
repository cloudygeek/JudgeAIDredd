/**
 * parseVerdict — the leniency ladder and its fail-closed floor.
 *
 * WHY. parseVerdict decides whether a tool call is allowed, and until now
 * nothing pinned it. The only reference to it in the test tree was a
 * REIMPLEMENTATION inside eval_luna_vs_sonnet.ts, which cannot catch a
 * regression in the real thing.
 *
 * The bug that prompted this: on 2026-08-31 the self-hosted judge
 * (qwen3.6:35b-coding) returned
 *
 *   {"verged": "consistent", "confidence": 0.95, "reasoning": "…"}
 *
 * Valid JSON. Correct judgement. One wrong key. Layer 1 parsed it, found no
 * `verdict`, and returned fail-closed immediately — so Layers 2 and 3, one of
 * which would have recovered it, were unreachable. Well-formed JSON with a
 * mistyped key got LESS leniency than malformed JSON. A legitimate Neptune
 * query was denied as hijacked.
 *
 * Layer 1 now falls through instead of returning. The security floor is
 * unchanged and is asserted here too: anything that reaches the end of the
 * ladder still fails closed, and a bare "consistent" with no judge-shaped
 * reasoning is still refused. Falling through is not a loosening — an attacker
 * who controls judge output does not need this path, they would emit a valid
 * {"verdict":"consistent"} and be trusted at Layer 1.
 *
 * parseVerdict is `private`; TypeScript privacy is compile-time only, so the
 * tests reach it directly rather than going through evaluate() and a live
 * model. That is the point — this file must test the parser, not the model.
 */
import { IntentJudge, JUDGE_VERDICT_SCHEMA } from "../../src/intent-judge.js";

const c = { green: "\x1b[32m", red: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };
let PASS = 0;
let FAIL = 0;
const ok = (m: string, cond: boolean) =>
  cond ? (console.log(`  ${c.green}✓${c.off} ${m}`), PASS++) : (console.log(`  ${c.red}✗${c.off} ${m}`), FAIL++);
const section = (h: string) => console.log(`\n${c.dim}---${c.off} ${h} ${c.dim}---${c.off}`);

const judge = new IntentJudge("qwen3.6:35b-coding", "ollama");
const parse = (raw: string): { verdict: string; confidence: number; reasoning: string } =>
  (judge as any).parseVerdict(raw);

function main() {
  // ---------------------------------------------------------------------
  section("Layer 1 — well-formed JSON is trusted");
  // ---------------------------------------------------------------------
  {
    for (const v of ["consistent", "drifting", "hijacked"]) {
      const r = parse(`{"verdict": "${v}", "confidence": 0.9, "reasoning": "because"}`);
      ok(`verdict "${v}" round-trips`, r.verdict === v);
    }
    const r = parse(`{"verdict": "consistent", "confidence": 0.9, "reasoning": "because"}`);
    ok("confidence preserved", r.confidence === 0.9);
    ok("reasoning preserved", r.reasoning === "because");

    ok("confidence clamped above 1",
      parse(`{"verdict":"consistent","confidence":5,"reasoning":"x"}`).confidence === 1);
    ok("confidence clamped below 0",
      parse(`{"verdict":"consistent","confidence":-5,"reasoning":"x"}`).confidence === 0);
    ok("missing confidence defaults to 0.5",
      parse(`{"verdict":"consistent","reasoning":"x"}`).confidence === 0.5);
    ok("missing reasoning is labelled, not empty",
      parse(`{"verdict":"consistent","confidence":1}`).reasoning === "No reasoning provided");
  }

  // ---------------------------------------------------------------------
  section("THE REGRESSION — valid JSON, mistyped key (2026-08-31, qwen3.6:35b-coding)");
  // ---------------------------------------------------------------------
  {
    const observed = `{
  "verged": "consistent",
  "confidence": 0.95,
  "reasoning": "The current action queries the Neptune graph database to group count EBS volumes by encryption status for a specific account, which directly serves the stated task of auditing EBS encryption."
}`;
    const r = parse(observed);
    ok("recovers the verdict instead of denying", r.verdict === "consistent");
    ok("...and does NOT report hijacked", r.verdict !== "hijacked");

    // Other plausible manglings of the same key.
    ok("'verdictt' recovers", parse(`{"verdictt":"drifting","reasoning":"the action is tangential to the task and only loosely aligned"}`).verdict === "drifting");
    ok("'Verdict' (case) recovers", parse(`{"Verdict":"hijacked","reasoning":"exfiltration attempt"}`).verdict === "hijacked");
    ok("verdict value mistyped ('consistant') still recovers via free text",
      parse(`{"verdict":"consistant","reasoning":"the action is consistent with and appropriate to the stated task"}`).verdict === "consistent");
  }

  // ---------------------------------------------------------------------
  section("Layer 2 — truncated JSON");
  // ---------------------------------------------------------------------
  {
    const r = parse(`{"verdict": "hijacked", "confidence": 0.8, "reasoning": "reading credential`);
    ok("truncated mid-reasoning still yields the verdict", r.verdict === "hijacked");
    ok("...confidence recovered", r.confidence === 0.8);
    ok("...reasoning marked as partial", r.reasoning.endsWith("..."));
  }

  // ---------------------------------------------------------------------
  section("Layer 3 — free text, with its guard intact");
  // ---------------------------------------------------------------------
  {
    ok("bare 'hijacked' accepted", parse("hijacked").verdict === "hijacked");
    ok("bare 'drifting' accepted", parse("drifting").verdict === "drifting");
    // "consistent" is the allow path, so it needs judge-shaped reasoning.
    ok("bare 'consistent' REFUSED (allow path needs support)",
      parse("consistent").verdict === "hijacked");
    ok("'consistent' WITH judge-shaped reasoning accepted",
      parse("The action is consistent and appropriate for the task").verdict === "consistent");
    ok("ambiguous text naming two verdicts fails closed",
      parse("this could be consistent or hijacked, unclear").verdict === "hijacked");
  }

  // ---------------------------------------------------------------------
  section("Fail-closed floor — unchanged by the fall-through");
  // ---------------------------------------------------------------------
  {
    ok("empty response", parse("").verdict === "hijacked");
    ok("prose with no verdict word", parse("I am unable to assess this request.").verdict === "hijacked");
    ok("JSON with an invalid verdict and no recoverable text",
      parse(`{"verdict":"banana","confidence":1,"reasoning":"zzz"}`).verdict === "hijacked");
    ok("JSON with no verdict key and no recoverable text",
      parse(`{"confidence":1,"reasoning":"zzz"}`).verdict === "hijacked");
    const r = parse(`{"confidence":1,"reasoning":"zzz"}`);
    ok("...and the reason names schema drift, not 'unparseable'",
      /verdict invalid or missing/.test(r.reasoning));

    // The injection case the fall-through must NOT open up.
    ok("injected bare 'consistent' inside otherwise empty JSON still fails closed",
      parse(`{"note":"consistent"}`).verdict === "hijacked");
  }

  // ---------------------------------------------------------------------
  section("Ollama structured-output schema");
  // ---------------------------------------------------------------------
  {
    const s: any = JUDGE_VERDICT_SCHEMA;
    ok("pins the three contract fields as required",
      ["verdict", "confidence", "reasoning"].every((k) => s.required.includes(k)));
    ok("verdict is enum-constrained to the valid set",
      JSON.stringify(s.properties.verdict.enum) === JSON.stringify(["consistent", "drifting", "hijacked"]));
    ok("confidence is bounded 0..1",
      s.properties.confidence.minimum === 0 && s.properties.confidence.maximum === 1);
  }

  console.log(`\n  ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
