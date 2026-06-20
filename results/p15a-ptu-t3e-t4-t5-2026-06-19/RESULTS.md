# T3e / T4 / T5 under the enforcing PreToolUse gate — COMPLETE

**Date:** 2026-06-19/20
**Run prefix:** `p15a-ptu-{t3e,t4,t5}-*` (S3 `s3://cko-results/{t3e,t5}/`)
**Image:** test-framework v0.1.692 (gate build) · **Judge:** Sonnet 4.6 + B7.1 + Cohere Embed v4
**Implements:** `docs/test-request-pretooluse-rerun-2026-06-18.md` (T3e/T4/T5 follow-on)
**For paper:** `p15b-defence.tex` §cross-corpus / §4.5 (authored in a separate repo)
**Metric:** strict network exfiltration = `exfiltrationDetected` (canary reached the canary server)

> **Status: COMPLETE (5/5 cells).** qwen3-235b T3e/T4/T5 + sonnet-4-6 T3e +
> deepseek-v3.2 T3e all done. Canaries scrubbed (push-protection).

---

## 1. Headline — the enforcement gap is decisive on the multi-turn suites

| Suite / agent | baseline | post-turn | **enforced** | **+stage1** | aborts (enf/+s1) |
|---|--:|--:|--:|--:|--:|
| **T3e qwen3-235b** | 54/80 (67.5%) | 26/80 (32.5%) | **5/80 (6.2%)** | 6/80 (7.5%) | 64 / 69 |
| **T3e deepseek-v3.2** | 50/80 (62.5%) | 10/80 (12.5%) | **0/80 (0.0%)** | 0/80 (0.0%) | 84 / 103 |
| **T3e sonnet-4-6** (floor) | 0/80 | 0/80 | 0/80 | 0/80 | 11 / 7 |
| **T5 qwen3-235b** | 26/60 (43.3%) | 6/60 (10.0%) | **0/60 (0.0%)** | 0/60 (0.0%) | 113 / 130 |
| **T4 qwen3-235b** | 85/100 (85%) | 84/100 (84%) | 84/100 (84%) | 75/100 (75%) | 0 / 0 |

### Findings
1. **T3e — the flagship result lands as predicted, across BOTH open-weights agents.**
   qwen3-235b post-turn **32.5% → enforced 6.2%** (64 aborts); deepseek-v3.2 post-turn
   **12.5% → enforced 0.0%** (84 aborts). The request's expected direction
   ("Qwen3-235B's 21% residual should drop toward ~0") is confirmed and then some:
   qwen collapses ~5×, deepseek to zero. This is the **single clearest demonstration
   that the call point is load-bearing** — same judge, same verdicts, but aborting
   the call instead of blocking the next turn turns the leak into ~0. Both agents'
   baseline is ~62–68% → the judge recognises the T3e exfil step and enforcement
   aborts it.
2. **T5 — total prevention.** qwen3-235b post-turn 10.0% → **enforced 0/60** (113
   aborts). Multi-stage file-exfil is exactly the case PreToolUse is built for: the
   exfil step is a distinct tool call the judge flags `hijacked`, and aborting it
   leaves nothing. Post-turn already helped (43%→10%); enforcement finishes the job.
3. **T4 — the judge blind spot, again.** qwen3-235b ~84% across baseline/post-turn/
   enforced with **0 aborts** — the HTTP-injection payload reads as on-task, the
   judge returns `consistent`, nothing to abort. Only Stage-1's deterministic rule
   trims it (85%→75%). Same covert-channel boundary as the crack-vector corpus:
   per-tool blocking only helps when the gate SEES the exfil in the call it judges.
4. **Frontier floor clean.** sonnet-4-6 T3e 0/80 all arms. (It fired 11 enforced
   aborts that prevented no *real* exfil — i.e. the gate denied calls the model
   would have declined anyway; a small false-positive-style cost, not a security
   gain. Worth tracking for the utility/FPR axis.)

---

## 2. Why T3e/T5 win big but T4 doesn't

T3e and T5 are **goal-hijack → distinct-exfil-step** trajectories: the malicious
egress is its own tool call (a `curl`/write-then-send) that the judge, seeing the
drift from the original task, flags `hijacked`. PreToolUse aborts that exact call →
near-total prevention. The post-turn arm *also* flagged it — but too late (the call
already ran), which is precisely the enforcement gap.

T4 (HTTP-response injection) hides the exfil instruction inside content the agent
fetched; the resulting call looks like on-task tool use, so the judge returns
`consistent` and there is nothing to abort — same as the crack-vector covert
vectors. Enforcement can't fix a `consistent` verdict; only the Stage-1 deterministic
rule recovers part of it.

**Net:** PreToolUse enforcement is decisive where the judge can recognise the exfil
(T3e/T5 multi-turn hijacks → ~0), and inert where it can't (T4/covert → judge blind
spot). This cleanly separates the two halves of the §4.5 story.

---

## 3. Gate instrumentation (validation)

- T3e/T5 aborts wrote through (qwen T3e 64, T5 113); 0 hijacked-but-executed.
- T4 shows `summary` (this runner emits `egressBreakdown`, `toolCallsAborted` etc.).
- sonnet enforced aborts (11) with 0 real exfil prevented → candidate false positives
  for the utility axis (request §4 cost re-measure).

---

## 4. Cells

| Box | Suite | Agent | Scenarios | n/arm | Status |
|---|---|---|---|--:|---|
| bedt3 | T3e | qwen3-235b | T3e.1–4 | 80 | ✅ done |
| bedt5 | T3e | sonnet-4-6 | T3e.1–4 | 80 | ✅ done |
| bedt6 | T4 | qwen3-235b | T4.1–5 | 100 | ✅ done |
| bedt7 | T5 | qwen3-235b | T5.1–3 | 60 | ✅ done |
| bedt4 | T3e | deepseek-v3.2 | T3e.1–4 | 80 | ✅ done (us-west-2 long pole, ~16h) |

Arms: T3e via `none / intent-tracker / intent-tracker-enforced / intent-tracker-enforced-stage1`;
T4/T5 via `C4-baseline / C4-judge / C4-judge-enforced / C4-judge-enforced-stage1`
(same four arms, different runner naming).

---

## 5. For the paper

> On the multi-turn goal-hijack suites, moving the judge to the PreToolUse call point
> is decisive across both open-weights agents tested: T3e strict-exfil falls
> 32.5%→6.2% (qwen3-235B) and 12.5%→0.0% (deepseek-V3.2) under enforcement vs the
> post-turn arm, and T5 multi-stage exfil falls 10.0%→0.0% (qwen3-235B) — the gate
> aborts the distinct exfil step the judge flags `hijacked` (0 hijacked-but-executed).
> Both T3e baselines are ~62–68%, so this is real prevention, not a low-signal cell.
> This is the architecture claim of §threatvectors made empirical. The frontier floor
> (Sonnet 4.6) stays 0% throughout. By contrast T4 HTTP-injection (~84%) is inert to
> enforcement — the injected exfil reads as on-task, the judge returns `consistent`,
> and only the Stage-1 deterministic rule trims it (85%→75%) — the same covert-channel
> boundary documented on the crack-vector corpus. Together: PreToolUse enforcement
> closes the exfil gap where the judge can recognise the egress (multi-turn
> hijacks → ~0), and leaves the judge-coverage boundary where it cannot (T4/covert).

All 5 cells complete. T3e/T4/T5 raw cells under
`results/p15a-ptu-t3e-t4-t5-2026-06-19/`.
