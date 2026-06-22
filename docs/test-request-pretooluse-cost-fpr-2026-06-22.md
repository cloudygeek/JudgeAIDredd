# Test requirement — per-call cost / FPR / utility (+ Haiku-judge tier) under the enforcing PreToolUse gate (p15a/defence)

**Date:** 2026-06-22
**Requested by:** P15 defence-paper authoring pass (Cloud-Security/Adrian/p15b/p15b-defence.tex)
**Priority:** HIGH — this is the **last data dependency** before the paper's DRAFT/DO-NOT-SUBMIT guard can be lifted.
**Harness:** `runner-t3e-pretooluse.ts` (legitimate-workload + Haiku-judge cells), image **v0.1.692 (gate build)**, run prefix `p15a-ptu-cost-*` / `p15a-ptu-haijudge-*`.
**Extends:** `docs/test-request-pretooluse-rerun-2026-06-18.md` §4 (cost/FPR — never executed) and `docs/test-request-pretooluse-openweights-t3e-2026-06-20.md` (the exfil table, now COMPLETE).

---

## 1. Why

The T3e/T4/T5 + crack-vector exfil tables are now done under enforcement (the 11-agent `tab:exfil-defended` is enforced; `results/p15a-ptu-t3e-openweights-2026-06-20`). Two things still rest on **post-turn** data and must be re-measured under per-call PreToolUse before submission:

1. **Cost / FPR / utility (§Performance, abstract cost clause).** The paper claims FPR $0\%$ `hijacked` / $20\%$ `drifting`, latency ${\sim}500$\,ms/call, compute ${<}3\%$ of agent spend, utility $0$–$33$\,pp. Per-call enforcement fires the judge on a **far larger fraction of calls** than post-turn blocking, and the T3e wave flagged candidate false positives (Sonnet 4.6 enforced fired 11 aborts on T3e + 2 on crack-vectors that prevented **no real exfil** — calls the model would have declined anyway). These numbers do not carry over.
2. **Haiku-4.5-judge tier comparison (`tab:judge-cmp`, §judge-tier robustness).** The "Haiku judge ≈ Sonnet judge" claim was measured **post-turn**; it needs the enforced call point to stay consistent with the rest of the paper.

---

## 2. Cells

### (A) FPR / utility under enforcement — *primary*
- **Workload:** the 10-task legitimate developer set (`scenarios/legitimate-tasks.ts`), **N=100 = 10 tasks × 10 reps**, same set behind the current §Performance FPR claim.
- **Arms:** `none` (baseline utility) · `intent-tracker-enforced` (per-call PreToolUse). Optionally `intent-tracker` (post-turn) to show the enforcement delta.
- **Agents:** Sonnet 4.6 (the recommended production judge target) + one open-weights agent (e.g. Qwen3-235B) to check FPR isn't agent-specific.
- **Record per run:** every PreToolUse verdict (`consistent`/`drifting`/`hijacked`) and whether the call was **aborted**; benign-task **completion** (utility); so we get (i) hijacked-deny FPR = legitimate calls wrongly aborted, (ii) drifting-soft rate, (iii) utility delta vs `none`.

### (B) Cost / latency under enforcement — *primary*
- From the same enforced runs (A) + the T3e enforced cells already on disk: extract **per-call judge latency**, **judge-invocation fraction** (share of tool calls that reach the LLM judge vs early-exit at Stage 1/2), and **compute as % of agent spend** under per-call gating. No new corpus needed — instrument the enforced runs and the existing `p15a-ptu-*` JSONs.

### (C) Haiku-4.5-judge T3e under enforcement — *secondary (consistency)*
- Re-run the T3e open-weights exfiltrator cells with a **Haiku 4.5 judge** (vs the Sonnet 4.6 judge), `intent-tracker-enforced` arm, **N=80/arm**, T3e.1–4 — same protocol as the Sonnet-judge cells. Lets `tab:judge-cmp` (Haiku ≈ Sonnet) be reported on the enforced call point.

---

## 3. Protocol (match the completed T3e cells)

Image **v0.1.692** (gate build); judge **Sonnet 4.6 + B7.1 + Cohere Embed v4** (Haiku 4.5 for cell C); strict metric where relevant; per-rep JSON carrying the `build` field; verify **0 hijacked-but-executed** on any enforced arm (gate-integrity check, as on the T3e wave).

---

## 4. Out of scope

- The exfil tables (T3e/T4/T5/crack-vector) — **done** under enforcement.
- T5 cross-vendor (GPT-5.1/Gemini) enforced cells — the paper text was scoped to Qwen3-235B T5 (enforced $43.3\%\to0\%$); only run these if a cross-vendor T5 claim is wanted back.

---

## 5. What this resolves

Replaces the post-turn §Performance / abstract cost-and-FPR numbers and the `tab:judge-cmp` judge-tier comparison with enforced-call-point figures. With these in, **every number in `p15b-defence.tex` is on the PreToolUse call point** and the DRAFT/DO-NOT-SUBMIT guard can be removed. Append a summary line here (FPR, drifting rate, utility delta, per-call latency, judge-invocation fraction, compute %) when the runs land.
