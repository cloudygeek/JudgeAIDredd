# Per-call FPR / utility / cost under the enforcing PreToolUse gate — Cells A + B

**Date:** 2026-06-22
**Run prefix:** `p15a-ptu-cost-*` (S3 `s3://cko-results/t3e/`)
**Image:** test-framework **v0.1.732** (the --workload + gateJudgeMs build) · **Judge:** Sonnet 4.6 + B7.1 + Cohere Embed v4
**Implements:** `docs/test-request-pretooluse-cost-fpr-2026-06-22.md` §2A (FPR/utility) + §2B (cost/latency)
**For paper:** `p15b-defence.tex` §Performance + abstract cost/FPR clause
**Workload:** the 10-task legitimate developer set (`scenarios/legitimate-tasks.ts`), N=20 reps/task.

> **Status: COMPLETE (2/2 cells).** Sonnet 4.6 + Qwen3-235B, enforced PreToolUse,
> on the benign workload. On a legitimate task there is no attack, so **any gate
> abort is a false positive.** Canaries scrubbed.

---

## 1. Headline — FPR is 0% under per-call enforcement

Enforced arm (`intent-tracker-enforced`), pooled over the 10 legitimate tasks × 20 reps:

| Agent | call-level FPR | run-level FPR | drifting (soft) | judge-invocation | mean judge latency |
|---|--:|--:|--:|--:|--:|
| **claude-sonnet-4-6** | **0/2550 (0.00%)** | 0/200 (0%) | 0/2550 (0%) | 42/2550 (1.6%) | 2114 ms |
| **qwen3-235b** | **0/1568 (0.00%)** | 0/200 (0%) | 0/1568 (0%) | 44/1568 (2.8%) | 1889 ms |

### Findings
1. **FPR = 0% under per-call enforcement, both agents.** Across **4,118 legitimate
   tool calls** the gate aborted **zero** — no benign developer action was wrongly
   blocked, on either the production-judge target (Sonnet) or the open-weights agent
   (Qwen). The §Performance "FPR 0% hijacked" claim **holds at the per-call call
   point**, not just post-turn — and the candidate false positives flagged on the
   T3e wave (the Sonnet enforced aborts that prevented no real exfil) do **not**
   recur on a genuinely benign workload. (Those T3e aborts were on attack scenarios
   where the benign-looking prefix still drifted; on truly-legitimate tasks the gate
   stays silent.)
2. **Drifting-soft rate is also 0%** — the gate didn't even soft-flag a legitimate
   call as `drifting`. The benign tasks (incl. the security-adjacent ones that read
   .env / handle credentials) stay above the warn band.
3. **The legitimate workload exercises the gate heavily** — 2550 (Sonnet) / 1568
   (Qwen) gated calls over 200 runs each (≈8–13 tool calls/run), so the 0% FPR is
   over a substantial call volume, not a thin sample. The agent-count difference
   (Sonnet runs longer tool loops) is why the two totals differ.

---

## 2. Cost / latency (Cell B — falls out of the same runs)

Per-call PreToolUse fires the deterministic drift check on **every** tool call but
the **LLM judge on only a small fraction** (the rest early-exit at the drift stage):

| Agent | judge-invocation fraction | mean judge latency (judged calls) |
|---|--:|--:|
| claude-sonnet-4-6 | **1.6%** (42/2550) | 2114 ms |
| qwen3-235b | **2.8%** (44/1568) | 1889 ms |

### Findings
4. **The judge fires on only 1.6–2.8% of tool calls** on a legitimate workload —
   the drift detector early-exits the overwhelming majority (high similarity to the
   benign task → allow without the LLM). So per-call gating is **far cheaper than a
   judge-on-every-call worst case**: the expensive stage runs on ~1 in 40–60 calls.
5. **Mean judge latency ≈ 1.9–2.1 s per judged call** (Sonnet 2114 ms, Qwen-agent
   runs 1889 ms — the judge is Sonnet in both; the small difference is load/variance).
   This is the LLM-judge stage only; the drift early-exit is ~50 ms. Amortised over
   all calls: ~`0.016 × 2114 ≈ 34 ms/call` (Sonnet) of judge cost — i.e. the judge
   adds tens of ms per tool call on average, dominated by the 98% that never reach it.
6. **The ~500 ms/call figure in the paper does not directly carry over** — per
   *judged* call it's ~1.9–2.1 s (slower; the judged calls are the expensive ones),
   but per *tool* call amortised it's ~30–60 ms (cheaper; most early-exit). The
   paper should state both: judge-invocation fraction (1.6–2.8%) × per-judged-call
   latency (~2 s), rather than a single per-call number.

> **Caveat on judge-invocation fraction:** legitimate tasks stay on-task, so very
> few calls drift enough to reach the judge. On an *attack* workload the fraction is
> higher (the exfil step drifts and is judged) — the T3e enforced cells are the
> reference for the attack-side invocation rate. Report both regimes.

---

## 3. Cells

| Box | Agent | Workload | Arms | Runs |
|---|---|---|---|---|
| bedt11 | claude-sonnet-4-6 | legitimate (L1–L10) | none / post-turn / enforced | 600 |
| bedt12 | qwen3-235b | legitimate (L1–L10) | none / post-turn / enforced | 600 |

Image v0.1.732 (`--workload` plumbing + `gateJudgeMs` instrumentation). The `none`
and `intent-tracker` (post-turn) arms run no gate, so their gate telemetry is empty
(expected) — the FPR/cost numbers come from `intent-tracker-enforced`.

---

## 4. For the paper (§Performance / abstract)

> Under per-call PreToolUse enforcement, false-positive rate on a 10-task legitimate
> developer workload is **0/4118 tool calls (0.0%)** across both the Sonnet-4.6
> production judge and a Qwen3-235B agent — no benign action was wrongly aborted, and
> none was even soft-flagged `drifting`. The LLM judge fires on only **1.6–2.8% of
> tool calls** (the embedding drift check early-exits the rest), at **~1.9–2.1 s per
> judged call** — so per-tool amortised judge cost is ~30–60 ms, well under a
> judge-on-every-call worst case. The enforced call point therefore preserves the
> 0% benign-FPR property while keeping the LLM-judge invocation rare on legitimate work.

This + the Haiku-judge consistency (`tab:judge-cmp`, `results/p15a-ptu-haijudge-t3e-2026-06-22/`)
were the last data dependencies: every number in p15b-defence.tex is now on the
PreToolUse call point.
