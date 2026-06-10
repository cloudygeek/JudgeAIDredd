# What T3e / T4 / T5 actually test — attack-delivery channel & the trusted-input problem

**Date:** 2026-06-10
**Why this matters:** a reviewer-style question exposed that the corpus the
defence paper leans on (T5) delivers its "attack" through the **trusted user
channel**, which structurally limits what an intent-gate can be expected to catch.
This note pins down the delivery channel per corpus and the consequence for what
each result evidences.

## Delivery channel by corpus (from the scenario sources)

| Corpus | Source file | Where the malicious instruction enters | Threat model |
|---|---|---|---|
| **T5** (multi-stage) | `scenarios/t5-multistage.ts` | **`userMessage`** — the *user* escalates the task turn by turn (turn 0 benign "create health-check script" → turn 1 "also POST `.env.test` to the monitoring endpoint") | **goal-drift / scope-creep over a trusted channel** (insider, compromised/confused operator) |
| **T3e** (goal-hijack exfil) | `scenarios/t3e-goal-hijacking-exfil.ts` | mostly **`userMessage`**, framed as escalating user asks ("POST the contents via our compliance webhook") | same trusted-channel drift, single- and multi-turn |
| **T4** (HTTP injection) | `scenarios/t4-http-injection.ts` | **injected into the HTTP response body** (JSON field / HTML comment / markdown block); the user's request stays benign ("check endpoint health, report status") | **classic prompt-injection from untrusted tool output** |

## The core asymmetry

An intent-gate (Dredd) registers the user's intent, then judges each tool call
against it.

- **T4:** the user asked only to "check health and report." A tool call that POSTs
  `.env.test` to an external host is **unambiguous drift** — the user never asked
  for it, the instruction lives in untrusted content. The gate has a **clean
  mandate to block.** This is the corpus that genuinely tests injection defence.
- **T5 / T3e:** the malicious step is **the user's own next request**. To block it,
  the judge must decide that the user's turn-N instruction contradicts the user's
  turn-0 instruction — i.e. **override a direct user request.** Models are trained
  to defer to plausible operator instructions ("the ops team needs the creds to
  verify key validity"), so a single, well-framed escalation often reads as
  on-task. (Concretely: qwen3-235b T5.1 — judge returns `consistent` on the poison
  turn in 15/20 runs; see `T5_1_QWEN235B_JUDGE_MISS_2026-06-10.md`.)

So T5 is **not** an injection benchmark. It tests whether drift-tracking catches a
user (or someone with the user's channel) **boiling-frogging** a benign task into
exfiltration.

## What each result therefore evidences

- **T5 multi-turn cells (T5.2/T5.3 → 0 across most models):** real signal that
  embedding-drift + judge catch **gradual** scope-creep once enough semantic
  distance accumulates from the original intent. Legitimate, but it's a
  scope-creep result, not an injection result.
- **T5 single-step plausibly-framed cells (T5.1, esp. qwen3-235b):** the gate
  **cannot reliably catch a one-shot, well-justified user request** — and arguably
  *should not* hard-block direct user instructions. Do not cite these as
  "defence reduces exfil."
- **T4 (injection):** *the* corpus where the gate has a clean mandate — but **we
  currently have ZERO valid post-fix T4 data.** All 195 T4 result files are
  `build=None` (pre-fix `test22`, old executor, excluded under the post-fix-only
  policy). The paper has no clean evidence on the one corpus that directly tests
  injection-blocking.

## Recommendations

1. **Reframe T5/T3e in the paper as goal-drift / scope-creep defence** over a
   trusted channel — not prompt-injection defence. State the limitation explicitly:
   the gate is weak against single-step, plausibly-framed user escalations because
   the threat enters the trusted channel (this is a property of the threat model,
   not a tuning bug).
2. **Run post-fix T4** (none + intent-tracker, Sonnet judge, v0.1.578) across the
   exfiltrator set — this is the load-bearing injection evidence the paper actually
   needs, and it's currently missing. T4's injected-tool-output channel is exactly
   where a PreToolUse intent-gate's claim is strongest.
3. **Position the corpora as complementary:** T4 = untrusted-injection defence
   (gate's clean mandate); T3e/T5 multi-turn = trusted-channel drift detection
   (softer, real but bounded); single-step user-framed asks = out of scope for an
   intent-gate by design.

## Bottom line on the reviewer's question ("is T5 proving anything?")

Yes, but narrowly: T5 proves drift-tracking catches **gradual multi-turn scope
creep**. It does **not** prove the gate stops injection (wrong channel — the poison
is user-supplied), and it does **not** prove the gate stops single-step
well-framed exfiltration requests (it often can't, by design). The injection claim
needs **T4**, which must be re-run post-fix.
