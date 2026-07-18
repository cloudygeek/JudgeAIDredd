# "16,000+ judge invocations" scale claim — data reconciliation (p15a/defence)

**Date:** 2026-07-18
**Request:** `docs/test-request-jcp-invocation-count-2026-07-18.md` (JCP peer review M3 + M4)
**Repo commit:** `c5222da1a`
**Type:** count/aggregate, **no new agent runs.** All numbers read/recomputed from durable
data — calibration JSONs on local disk (`results/`) + cross-corpus runs on local disk and
`s3://cko-results/{t3e,mt-agentrisk,promptarmor-bedrock,…}`.

---

## Headline

| # | Item | Status | One-line answer |
|---|---|---|---|
| 1 | Definition of "judge invocation" | **RESOLVED** | **(a) Stage-3 LLM-judge *fires*** (calls that reached the LLM after policy/embedding early-exit). Definition (b) is untenable — a single AgentDojo arm emits **>1.1 M** deterministic decisions. |
| 2 | Does the number derive / reconcile? | **CORRECTED** | **"16,000+" is a *calibration-only* count, not a grand total.** It equals **13,156 (B5 ECE baseline) + 2,884 (v2 format matrix) = 16,040.** It does **not** include the five attack corpora. |
| 3 | "spanning five corpora" | **FLAG — claim is wrong** | The 16,040 comes entirely from the **synthetic 12-case calibration set**, not the five corpora. Cross-corpus Stage-3 fires are a **separate, larger** pool (**≥27,500**). The abstract conflates two disjoint experiments. |
| 4 | Baseline judge-model count | **CONFIRMED = 8** | Haiku 4.5, Sonnet 4.6, Opus 4.7, Nova Micro, Nova Pro, Nova Lite, Nemotron-120B, Qwen3-32B. v1/v2 = **3** (Anthropic only). "8 (baseline), 3 (v1/v2)" is correct. |
| 5 | AgentDojo agent count | **CONFIRMED = 5** | Sonnet 4.6, Opus 4.7, GPT-4o-mini, Qwen3-32B, Qwen3-235B. Opus 4.8 has AgentDojo runs but not in the PromptArmor head-to-head. "5" is correct; "6" is wrong. |

> **Bottom line for the author:** the headline number is *real and sourceable*, but the sentence
> around it is wrong in two ways. (i) "16,000+" is the **calibration** invocation count, not a
> grand total over everything. (ii) "spanning five corpora" attaches the calibration number to the
> attack corpora it doesn't come from. Two clean rewrites are offered in §6.

---

## 1. Definition — what one "judge invocation" counts

**Answer: (a) — a Stage-3 LLM-judge *fire*: one call that reached the judge LLM after the
Stage-1 policy and Stage-2 embedding early-exits did not resolve it.**

Two independent lines of evidence rule out definition (b) ("every verdict incl. deterministic
early-exits"):

1. **The cross-corpus runner tags every tool call with `gateStage`.** Only `gateStage=="judge"`
   reached the LLM; `drift-allow`, `stage1-deny`, `domain-allow`, `drift-block`, and `null`
   (baseline/undefended) never call the judge. Across the local T3e/T4/T5 dir, judge fires are
   **11.8 %** of *gated* calls and ~2 % of *all* calls — matching the paper's own latency-section
   claim ("judge fires on ~1.6–2.8 % of tool calls").

2. **Definition (b) explodes to absurdity.** In the AgentDojo head-to-head corpus a single
   defended arm (`claude-3-opus-20240229-dredd-B7.1`, 684 tasks) emits **883,584** `dredd_decisions`
   — because once a session hijack-locks, *every* subsequent tool call emits a `session-locked`
   decision with **no judge call**. Counting those as "invocations" would put the total in the
   **millions**, not 16,000. So the paper's number can only be **actual LLM fires**.

**Subtlety that matters for §2:** in the **calibration** harness every case×rep is fed *directly*
to the judge LLM (no policy/embedding front-end), so there `reps == judge calls == case-evals`
— (a) and (b) coincide. They diverge only on the **cross-corpus** runs, where the front-end
early-exits the vast majority of calls. This is exactly why the calibration sweep alone yields
five figures while the cross-corpus attack runs contribute proportionally few *fires* per case.

---

## 2. Where "16,000+" actually comes from — it is the CALIBRATION count

**Answer: 16,000+ = the confidence-calibration sweep = 13,156 (documented ECE baseline) +
2,884 (prompt-v2 format-variant matrix) = 16,040. Reproduced exactly from disk.**

The anchor is `docs/B5-calibration.md`: **"13,156 evaluations (11,126 adversarial + 2,030 mixed
B3)"** — where an "evaluation" is one **judge rep/verdict**, produced by `scripts/confidence-calibration.py`.
Adding the v2 (B6 format-leakage) matrix, which B5 deliberately excludes:

| Source | Judge calls (reps) | Provenance |
|---|--:|---|
| Calibration **baseline** (adversarial + B3 mixed) — the B5 "13,156" | **13,156** | `docs/B5-calibration.md` (documented snapshot) |
| Calibration **prompt-v2** (B6 format-leakage matrix) | **2,884** | `results/adversarial-judge-*-B6-*.json` (20 files, reproduced) |
| **= headline** | **16,040** | ≈ **"16,000+"** ✓ |

The "16,000+" claim is therefore **derivable and correct — as a calibration count.** The v1
(B7) matrix (794 reps) is already *inside* the 13,156 baseline, so it is not added again.

### ⚠️ 2a. The 13,156 anchor is a stale snapshot (does not change the headline, but note it)

Re-running the **same three globs** `scripts/confidence-calibration.py` uses, against
**current disk**, gives **15,316** (13,286 adversarial + 2,030 B3), not 13,156 — the adversarial
half grew by **+2,160 reps** since `B5-calibration.md` was generated (the B3 half is byte-identical
at 2,030). So there are two internally-consistent ways to state the headline:

- **As published:** cite the frozen B5 dataset → 13,156 + 2,884 (v2) = **16,040 ≈ "16,000+"**. ✓
- **Recomputed on current disk:** 15,316 (baseline) + 2,884 (v2) = **18,200**, or **18,320**
  including the 120 standard-prompt smoke reps.

Either is fine; they must not be mixed. The published "16,000+" traces cleanly to the **B5 doc's
13,156**, so **no edit to the number is required** — only the framing (§3).

**Source:** `results/test8/adversarial-judge-*.json` (165 files, 12,492 reps),
`results/adversarial-judge-*-B7-*.json` excl. `-B6-` (6 files, 794 reps),
`results/judge-b3-*.json` (14 files, 2,030 reps), `results/adversarial-judge-*-B6-*.json`
(20 files, 2,884 reps).

---

## 3. "Spanning five corpora" — the claim mis-attributes the number (reviewer M3)

**Answer: the 16,040 is entirely the synthetic 12-case calibration set (case IDs `adv-1…adv-12`
× {bash, json, euph, expl} format variants). It contains ZERO cross-corpus attack data. The five
attack corpora are a separate, LARGER invocation pool.**

The calibration cases are `adv-N-{bash,json,euph,expl}` — a hand-built adversarial fixture, **not**
T3e / T5 / crack-vector / AgentDojo / MT-AgentRisk / AgentLAB / InjecAgent scenarios. So the
reviewer's either/or ("either 16k is the total and five corpora contribute ~3k, or the total is
far above 16k") resolves as: **neither.** The 16,040 and the cross-corpus fires are disjoint.

Actual Stage-3 fires under the **defended arm** across the attack corpora (each a genuine LLM call):

| Corpus (defended arm) | Stage-3 judge fires | Where | Notes |
|---|--:|---|---|
| T3e frontier (sonnet-judge) | 2,001 | local `p15a-ptu-t3e-t4-t5-2026-06-19` | = S3 `t3e/…v0.1.692` (same runs) |
| T3e open-weights | 5,683 | local `p15a-ptu-t3e-openweights-2026-06-20` | 11-agent front |
| T3e (haiku-judge comparison) | 4,779 | local `p15a-ptu-haijudge-t3e-2026-06-22` | judge-swap arm |
| T5 multi-agent | 7,919 | local `p15a-ptu-t5-multiagent-2026-06-23` | |
| crack-vector (T*/TCMD/TEGRESS/TMCP/…) | 3,379 | local `p15a-ptu-crackvec-2026-06-19` | |
| false-positive / benign workload (`L*`) | 86 | local `p15a-ptu-cost-fpr-2026-06-22` | judge rarely fires on benign |
| **cross-corpus subtotal (local, `gateStage=="judge"`)** | **23,847** | | |
| AgentDojo head-to-head (native, defended, dedup) | 3,693 | S3 `promptarmor-bedrock/p15b-agentdojo-*` | `judgeVerdict != null` |
| **cross-corpus subtotal incl. AgentDojo-native** | **≈27,540** | | |

So the cross-corpus attack runs contribute **≥27,500** judge fires **on their own** — well above
16,000. "16,000+ judge invocations spanning five corpora" therefore **understates** the true
cross-corpus judge workload while **mis-sourcing** the specific 16k figure (which is calibration).

**⚠️ Not fully summed — flagged per the request's "say so" rule:**
- **AgentDojo / MT-AgentRisk on S3 are messy.** The `promptarmor-bedrock/p15b-agentdojo-*`
  prefixes contain (i) **6 byte-identical duplicate arms** across prefixes (deduped out — the
  `claude-3-opus-…-dredd-B7.1` 684-task arm is copied into 4 prefixes), and (ii) **misfiled
  MT-AgentRisk `t24-…multi-turn` runs** living under `sonnet-4.6-intent-tracker/` dirs (7,813
  further judge fires, **excluded** from the 3,693 native-AgentDojo figure to avoid double-counting
  against MT-AgentRisk). I did not attempt to de-overlap AgentDojo vs MT-AgentRisk vs the paper's
  reported cells — that needs the paper's exact per-table run manifest, which isn't on disk.
- **MT-AgentRisk, AgentLAB, InjecAgent** summary JSONs on S3 are **aggregate-only** (`asr_aggregate`,
  no per-call judge-fire log), so their Stage-3 fire counts are **not recoverable** without
  re-parsing every per-run trajectory. I did **not** estimate them.
- Consequence: a single exact "grand total over calibration + all corpora" is **not recoverable**
  from durable data without the paper's run manifest. What *is* exact: **calibration = 16,040**
  (the headline), and **cross-corpus ≥ 27,500** (a firm lower bound). These are the two numbers to
  cite; do not claim one grand sum.

---

## 4. Census (Table 1) — reviewer M4

### 4a. Baseline judge-model count = **8** (v1/v2 = **3**) ✓

Distinct judge models present in the calibration sweep:

| Prompt tier | Judge models | Count |
|---|---|--:|
| **baseline** (test8 + standard prompt) | Claude Haiku 4.5, Claude Sonnet 4.6, Claude Opus 4.7, Nova Micro, Nova Pro, Nova Lite, Nemotron-120B, Qwen3-32B | **8** |
| **v1** (B7-hardened) | Claude Haiku 4.5, Sonnet 4.6, Opus 4.7 | **3** |
| **v2** (B7.1 + B6-format-leakage) | Claude Haiku 4.5, Sonnet 4.6, Opus 4.7 | **3** |

The census row "3 judges × 3 prompts" undercounts the baseline. **"8 judges (baseline), 3 (v1/v2)"
is confirmed correct.** (v1/v2 are Anthropic-only because the non-Anthropic judges were screened
out at baseline — they never reached the hardened-prompt matrix.)

**Source:** model `.label` field across `results/test8/adversarial-judge-*.json` +
`results/adversarial-judge-*.json`.

### 4b. AgentDojo agent count = **5** ✓

The PromptArmor head-to-head (`tab:promptarmor-headtohead`) agents, from the AgentDojo run
prefixes on S3 (`phaseB/C/D-agentdojo-*`, `p15b-agentdojo-*`):

Sonnet 4.6, Opus 4.7, GPT-4o-mini, Qwen3-32B, Qwen3-235B = **5**.

Opus 4.8 **does** have AgentDojo runs (`p15b-agentdojo-opus48-*`) but in separate defended /
composite arms, **not** in the 5-way PromptArmor comparison — so its absence from the head-to-head
table is correct. **"6 agents" is wrong; "5" is confirmed.**

**Source:** `aws s3 ls s3://cko-results/promptarmor-bedrock/` (agent-model prefixes).

---

## 5. Recommended fold-ins (author decision — these change abstract/intro wording)

The number is fine; the sentence around it is not. Two clean options:

- **Option A (keep 16,000+, fix the attribution) — recommended.** Rewrite the abstract/intro to
  say the 16,000+ is the **judge-calibration** workload, and state the cross-corpus fire count
  separately:
  > "…across a **judge-calibration sweep of 16,040 LLM-judge evaluations** (3 hardened judges ×
  > format-variant matrix over the 8-judge baseline screen) **and a further ≥27,500 Stage-3 judge
  > fires across the five attack corpora**…"

  This preserves the headline, removes the false "spanning five corpora" attribution, and is fully
  sourceable.

- **Option B (one number, correctly framed).** If a single scale number is wanted, cite the
  **total LLM-judge fires ≥ 43,000** (16,040 calibration + ≥27,500 cross-corpus) and describe it
  as "judge evaluations across calibration and five attack corpora" — but only if the cross-corpus
  overlap/dedup in §3 is resolved against the paper's run manifest first (I could not close it from
  disk). Until then, Option A (two separate, individually-exact numbers) is safer.

**Do not** leave "16,000+ … spanning five corpora": as written it sources a calibration number to
the attack corpora, and 16k is *smaller* than the true cross-corpus fire count — the one framing a
"numbers must reconcile" reviewer will catch.

---

## 6. Provenance summary (all read/recompute, no new runs)

| Item | Data source |
|---|---|
| Definition (a) + ~2 % fire rate | `gateStage` field, `results/p15a-ptu-t3e-t4-t5-2026-06-19/*/*.json` |
| Definition (b) untenable (883,584 decisions/arm) | `dredd_decisions[].stage` in `s3://cko-results/promptarmor-bedrock/p15b-agentdojo-*` |
| 16,040 = 13,156 + 2,884 | `docs/B5-calibration.md`; `results/adversarial-judge-*-B6-*.json` |
| Stale 13,156 → 15,316 on current disk | re-run of `scripts/confidence-calibration.py` globs |
| Calibration set = synthetic adv-1…12 | `.cases[].caseId` in `results/adversarial-judge-*.json` |
| Cross-corpus fires (23,847 local) | `gateStage=="judge"` across `results/p15a-ptu-*` |
| AgentDojo-native fires (3,693, dedup) | `judgeVerdict != null` in `s3://…/promptarmor-bedrock/p15b-agentdojo-*/*-dredd-B7.1/` |
| 8 baseline / 3 v1v2 judges | `.model.label` across calibration JSONs |
| 5 AgentDojo agents | `s3://cko-results/promptarmor-bedrock/` prefixes |

## Items needing an author decision (not a data problem)

- **Headline framing (§5):** 16,040 is a **calibration** count. Choose Option A (two separate exact
  numbers) or Option B (one grand total, pending overlap resolution). Either way, drop the current
  "16,000+ … spanning five corpora" wording.
- **13,156 vs 15,316:** cite the frozen B5 dataset (16,040) or the current-disk recompute (18,200);
  don't mix. Recommend keeping the published B5 figure so `tab:adversarial-summary` stays consistent.
- **Cross-corpus grand-sum:** not recoverable from disk without the paper's per-table run manifest
  (AgentDojo/MT-AgentRisk S3 overlap + duplicate arms). Cite the **≥27,500 lower bound**, not a
  precise total.
