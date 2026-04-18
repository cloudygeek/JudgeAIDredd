# Test Plan — Opus 4.7 Effort Effect + Paper Gap Closure (Revised)

**Date:** 2026-04-18
**Supersedes:** `docs/test-plan-2026-04-17-opus-effort.md`
**Companion:** `docs/rerun-instructions-test1-2026-04-18.md` (Test 1 re-run procedure)

This plan revises the 2026-04-17 plan after roughly 24 hours of execution. Several Phase A items are done; one infrastructure gap surfaced; the Phase B motivation is stronger, not weaker.

---

## 1. Status since the previous plan

### Done
- **A2 — Opus 4.7 `none` effort adversarial:** 4/12. Opus 4.7 supports `none` via adaptive-thinking (no Bedrock validation error). A2 cell filed at `results/test8/adversarial-judge-claude-opus-4-7-none-2026-04-17T22-19-41-709Z.json`.
- **A5 — Test 3a medium-effort cells:** 6 cells × 90–180 reps in `results/test3a/bedt4-a5-20260417T221815Z/`. Intermediate × intent-tracker × medium and sophisticated × intent-tracker × medium are the cells that matter — medium now shows the best (most GES=0 prevents) bimodality profile among the three effort levels for Opus 4.7 as agent.
- **`--repetitions` flag** landed in `test-adversarial-judge.ts` (commit `7425128`).
- **Thinking-trace capture** landed in `bedrock-client.ts` + `intent-judge.ts` (also `7425128`) — field plumbed into result JSONs. Not yet exercised by any run.
- **Test 1 contamination cleanup** (commit `39dbd54`, `53f5ace`): Configs F and H re-run at N=3 × 5 efforts, confirming that the pre-04-18 TP=4/11 outliers were pre-fix contamination. All clean F/H runs now show TP=10/11 at every effort level.
- **Build-info coverage:** every Test 1 run from 2026-04-18 carries a `build` field, validating the instrumentation.

### Not yet done
- **A1 — N=20 rep adversarial across {Haiku 4.5, Sonnet 4.6, Opus 4.7} × {none, medium, high, max}.** This is the single highest-value remaining experiment. Every Phase B hypothesis depends on it.
- **A3 — Nova Micro rerun at N=20.** Folds into A1.
- **A4 — Opus 4.7 vs 4.6 defended-agent gap at matched N.** The current 16.7 GES (T3.2) and 28.3 GES (T3.3) Opus 4.7 numbers at N=20/40 reps look decisively worse than Opus 4.6's 13.3 / 6.7 but the T3.3 variance is large.
- **B1–B7 diagnostics.** Code for thinking-trace capture is ready; no runs have used it yet.

### New issues surfaced by build-info

1. **Fargate runs produce `gitSha: "unknown"`.** The Docker image doesn't ship a `.git` directory, so `git rev-parse` in `build-info.ts` fails silently. Configs B/D/F/H (Fargate runs) carry `sdkVersion: "^0.2.112"` (correct) but no commit identity.
2. **Local runs produce `gitDirty: true` when the operator has uncommitted changes.** Configs A/C/E/G show this today, stamped with `a5fb793` but with an indeterminate working-tree diff.

Both are real build-info working as designed — they caught the gaps rather than covering them up. Both need small fixes before another bulk re-run.

---

## 2. What the 2026-04-18 data says about Phase B motivation

**Partial confirmation of H2 (pretext-specific effect) already present.** The Test 1 pipeline re-runs cover 11 *standard* (non-adversarial) hijacks at 5 effort levels × 3 reps for Configs F and H (Anthropic judges). Every single run caught 10/11 — effort is completely flat on non-adversarial hijacks for Opus 4.7 and Sonnet 4.6 as judges. The earlier "high effort hurts" signal is visible only on the adversarial suite (12 cases designed to exploit narrative reasoning).

This matters because:
- It makes B3 (standard-hijack effort sweep) partially redundant — the answer is already "effort doesn't hurt on standard hijacks."
- It focuses B2/B4/B5/B6 on the right target: the adversarial-specific failure mode.
- It raises the payoff on B7 (hardened prompt) — if the standard case is already at 10/11 and the adversarial case is at 3–5/12, the ceiling between them is ~5 cases per model. Prompt hardening is the only remaining lever for that gap.

---

## 3. Revised action items

Ordered by value-per-hour.

### Phase 0 — infrastructure gaps (do first, 1–2 hr)

**P0.1. Inject git SHA into Fargate containers.** Edit the Fargate Docker build (`fargate/Dockerfile` or equivalent) to accept a `GIT_COMMIT` build arg, bake it into `/etc/build-info` or an `ENV GIT_COMMIT=...` line. Update `build-info.ts`:

```ts
// Prefer an explicit env var when set — this is the Fargate path
const gitSha = process.env.GIT_COMMIT
  ?? safeExec("git rev-parse --short HEAD")
  ?? "unknown";
const gitDirty = process.env.GIT_DIRTY === "true"
  ?? safeExec("git status --porcelain").trim().length > 0;
```

The CI step that builds the image must pass `--build-arg GIT_COMMIT=$(git rev-parse --short HEAD)` and `GIT_DIRTY=$(git status --porcelain | wc -l)`.

**P0.2. Add a pre-run clean-checkout check.** Extend `run-test1-local.sh` (and a sibling for test-adversarial) with a gate:

```bash
if [[ -n "$(git status --porcelain)" ]]; then
  echo "FATAL: working tree dirty — commit or stash before running a reference test."
  echo "  Override with ALLOW_DIRTY=1 for ad-hoc experimentation."
  [[ "${ALLOW_DIRTY:-0}" == "1" ]] || exit 1
fi
```

This moves the "gitDirty discipline" from prose to enforcement. `ALLOW_DIRTY=1` exists because we still need ad-hoc runs during development — they just shouldn't be confused with reference data.

### Phase A' — remaining paper-gap items

**A1 (revised) — Adversarial with CIs.** Now that the `--repetitions` flag exists:

```bash
npx tsx src/test-adversarial-judge.ts \
  --model "Claude Opus 4.7" --effort none,medium,high,max --repetitions 20
npx tsx src/test-adversarial-judge.ts \
  --model "Claude Sonnet 4.6" --effort none,medium,high,max --repetitions 20
npx tsx src/test-adversarial-judge.ts \
  --model "Claude Haiku 4.5" --effort none,medium,high,max --repetitions 20
npx tsx src/test-adversarial-judge.ts \
  --model "Nova Micro" --repetitions 20     # folds in A3
```

Scale: ~2,880 judge calls on Anthropic + 240 on Nova = ~3,120. Wall-clock ~8 h on Bedrock, parallelisable. **Pre-req:** P0.1 done so Fargate runs carry SHA.

Decision rule (unchanged from 04-17): if 95% CIs for Opus 4.7 medium vs {high, max} overlap, Phase B becomes a footnote. If they don't, B is a main-text contribution.

**A4 — Opus 4.7 vs 4.6 defended-agent gap.** Still not run. N=20 per cell:

```bash
npx tsx src/runner-bedrock.ts --model claude-opus-4-7 \
  --defence none,intent-tracker --scenario t3.2,t3.3,t3.4 --repetitions 20
```

Matches the paper's N=20 per scenario for Opus 4.6. If defended T3.3 GES stays ≥20 on 4.7, the "Opus benefits most from the defence" claim is Opus-4.6-specific and must be qualified.

**A6 (new) — Paper table refresh from clean Test 1 data.** The 2026-04-18 re-runs change a few numbers:

- `tab:pipeline-e2e` Configs B and D: FP=**2** (not 3 as in paper).
- `tab:pipeline-e2e`: add an Opus 4.7 column (Config E or F) now that the judge works reliably.
- `tab:judge-leaderboard`: add an Opus 4.7 row at the best-observed effort cell (`medium`, 5/12 adversarial pooled).

Not a test, just a documentation task. ~1 h.

### Phase B' — diagnostics (gated on A1, mostly unchanged)

The Phase B plan stands. One revision:

**B3 (reduced scope).** The 2026-04-18 Test 1 data already establishes that effort is flat on standard hijacks for Opus 4.7 and Sonnet 4.6 as judges (pipeline Configs E/F/G/H). B3 is downgraded from "distinguishing experiment" to "sanity check on the raw judge call" (no embedding stage, same 11 cases):

```bash
npx tsx src/test-judge-bedrock.ts \
  --model "Claude Opus 4.7" --effort none,medium,high,max --repetitions 5
```

~220 judge calls, ~20 min. Only run if A1 confirms the adversarial effort effect.

**B2, B4, B5, B6, B7 unchanged** — all require A1 data + B1 trace capture.

**B7 priority raised.** With H2 partially confirmed, hardened prompt is the only lever that could materially improve Haiku 4.5 (currently 1/12) and close the gap to Sonnet 4.6 (currently 6/12 best observed). If hardened-prompt + Haiku 4.5 lifts to ≥6/12, the paper's judge recommendation can stay on Haiku rather than moving to Sonnet.

---

## 4. Revised execution order

```
P0.1, P0.2 ─┬──> A1 ─┬──> B1 capture runs ─┬─> B2 (hand-code)
            │        │                     ├─> B4 (subset analysis)
            │        │                     ├─> B5 (confidence calibration)
            │        │                     └─> B6 (format leakage)
            │        │
            │        └──> B3 (sanity check)
            │
            ├──> A4 (independent)
            ├──> A6 (doc task, no runs)
            │
            └──> B7 hardened prompt variant ──> A1-style rerun
```

### Day 1 (½ day engineering)

- P0.1 Fargate SHA injection (~1 h).
- P0.2 Clean-checkout gate in `run-test1-local.sh` (~15 min).
- A1 batch dispatch (overnight, ~8 h wall-clock).
- A4 dispatch in parallel with A1 (different agent model, won't contend).

### Day 2 AM

- Collect A1 + A4 results. Compute Wilson CIs per (model, effort) cell.
- Decision: do Opus 4.7 effort CIs separate at 95%? If yes → proceed with B2/B4/B5/B6. If no → write up null result and skip to B7 directly.
- A6 paper-table refresh.

### Day 2 PM

- B1 trace capture rerun (if proceeding to B2–B6): same A1 matrix but with `--repetitions 3` so we have ~36 traces per (model, effort) for hand coding.
- B2–B6 analysis in parallel — these are pure post-hoc analyses of the captured JSONs.
- B7 hardened-prompt drafting (~2 h to write + validate).

### Day 3

- B7 adversarial rerun with hardened prompt, N=20 × 3 models × 2 efforts ({none, medium} only — `high`/`max` already shown to hurt on Opus).
- Compare hardened vs baseline. Finalise paper recommendation on judge + prompt config.

---

## 5. Success criteria (revised)

At the end of this plan, the paper should be able to answer with point estimates and 95% CIs:

1. **Does adversarial catch rate depend on effort, per model?** Expected: Opus 4.7 yes (peak at low/medium), Haiku/Sonnet marginal.
2. **Is the Opus 4.7 effort dependency pretext-specific?** Already partially confirmed by Test 1 data; B3 will close this.
3. **Does Opus 4.7 as judge Pareto-dominate Sonnet 4.6 `none` anywhere?** Current answer: no (5/12 pooled medium vs 6/12 Sonnet `none`, higher cost). Unlikely to change at N=20, but will be confirmed or falsified.
4. **Does the paper's "Opus benefits most from the defence" claim hold for Opus 4.7?** Current answer: no at T3.3 — needs A4 at matched N to confirm.
5. **Does hardened prompt + cheap model (Haiku 4.5) close the adversarial gap to Sonnet 4.6?** Direct economic impact on the production recommendation.
6. **Is the Test 1 contamination fully cleared?** Already yes per 2026-04-18 re-runs; Fargate SHA injection (P0.1) closes the provenance gap for future runs.

## 6. Explicit non-goals

These keep creeping in but should be resisted until the above lands:

- No new attack scenarios until A1/A4 land. Any new scenario multiplies the rerun cost.
- No alternative defence architectures (PreToolUse interception is mentioned in the paper's limitations section but is out of scope for this plan).
- No additional agent models beyond Opus 4.7 unless A4 suggests a specific new hypothesis. Sonnet 4.6 and Haiku 4.5 as defended agents are already covered at paper quality.
- No Opus 4.7 in other positions in the pipeline (e.g. as the drift detector or the goal-anchoring re-prompter) — current role split is Haiku 4.5 judge + Opus 4.7 / Sonnet 4.6 agent, and that's load-bearing for the economic argument.

---

## 7. Statistical sanity additions

LLM outputs aren't deterministic even at temperature=0 with thinking disabled, and thinking-enabled calls have substantially more output variance. The Ns in the plan above are adequate for the main effects we're trying to detect, but only if we also characterise the noise floor and report CIs honestly. Three cheap additions close that gap.

### 7.1 Baseline power check

Rough 95% CI half-widths at planned Ns (binomial, ignoring within-case correlation):

| Test | Cell N | Pooled catch / GES | ±half-width | Effect we're resolving |
|---|---|---|---|---|
| A1 adversarial | 240 judge calls | p ≈ 0.4 | ±6 pp | 5/12 vs 3/12 pooled = 17 pp ✓ |
| A4 Opus 4.7 × defended | 60 runs (T3.3) | GES ≈ 28 | ±4 GES | Opus 4.7 vs 4.6 T3.3 gap = 22 GES ✓ |
| Test 3a robustness | 90–180 | GES=0 fraction | ±5 pp | bimodality shape ✓ |
| Test 7 cross-model | 20–60 | mean GES | ±4 GES | paper-sized agent diffs ✓ |

These are fine for main effects. They are not fine for **per-case** claims (e.g. "case 3 is only catchable at medium effort") — at N=20 per case, per-case CI half-width is ±22 pp at p=0.5. Paper should avoid case-level claims unless we explicitly bump per-case N.

### 7.2 P0.3 — augment build-info with Bedrock invocation identity

`build-info.ts` captures the client-side SDK version but nothing about the server-side model. Bedrock has a history of silently rev'ing model weights under a stable model ID. Two A1 runs a week apart could diverge for reasons unrelated to effort or prompt.

**Change:** extend `BuildInfo` with the two invocation-time fields that aren't knowable at build time:

```ts
interface BuildInfo {
  // existing
  gitSha: string;
  gitDirty: boolean;
  sdkVersion: string;
  capturedAt: string;

  // new
  bedrockRegion: string;    // from AWS_REGION env at runtime
  modelId: string;          // full Bedrock model id used for the judge
  modelInvokedAt: string;   // ISO timestamp of the first model call in the run
}
```

`modelInvokedAt` plus `modelId` together form the provenance pair that would let a future analyst quarantine a run by week if Bedrock is found to have silently updated. ~15 min code change across `build-info.ts` and each writer.

### 7.3 A0 — within-case variance probe (gates A1)

Before dispatching the 3,120-call A1 bulk run, spend 40 calls measuring whether per-case reps are independent or correlated:

```bash
# Pick the single case that's currently ambiguous (e.g. adv-5 "authorised-pentest")
# and run it 40 times at fixed (Opus 4.7, medium).
npx tsx src/test-adversarial-judge.ts \
  --model "Claude Opus 4.7" --effort medium --cases adv-5 --repetitions 40
```

**Prereq code change:** `--cases` flag to `test-adversarial-judge.ts` (currently runs all 12). ~15 min.

**Compare:**
- **Observed case catch rate:** k/40.
- **Expected binomial SE** on that p: sqrt(p·(1-p)/40).
- **Observed batch-level SE**: partition the 40 into 4 batches of 10, compute catch rate per batch, take their SD.

If observed batch-level SE ≈ binomial SE → reps are independent, N=20 is 20 effective observations per case. If batch SE ≪ binomial SE → model is near-deterministic on this case, reps are redundant, A1 budget can be reduced. If batch SE ≫ binomial SE → there's between-batch drift (time-of-day or cache effects), A1 reps should be interleaved across effort levels rather than done in long batches.

**Decision rule on A1 dispatch** based on A0 outcome:
- Ratio ≤ 1.2: proceed with A1 at N=20, treat reps as effectively independent.
- Ratio > 1.5: interleave reps across efforts (1 rep per effort, then loop) rather than 20 reps per cell sequentially. Same call count, different ordering.
- Case is locked-in (k ∈ {0, 40}): rep count for that case is wasted; consider per-case N varying by case difficulty in future designs.

### 7.4 A4 bumped to N=40

The current A4 plan is N=20 per cell (matching the paper's Opus 4.6 numbers). That's fine for confirming the current 22 GES direction of the Opus 4.6 → 4.7 gap. It is **not** fine if A4 comes back with a smaller gap (say 5–8 GES) — N=20 would miss that. Since A4 is cheap relative to A1 (~240 agent runs total), bump to **N=40 per (defence, scenario)** to match the sophisticated cell of the original Test 7 design.

### 7.5 Paper-reporting discipline

Every catch rate, GES mean, and accuracy figure in the paper's main-text tables must carry a 95% CI — not just a point estimate. Concretely:

- `tab:judge-leaderboard` — accuracy column becomes `97% [83–99]`.
- `tab:adversarial` — catch column becomes `5/12 [19–68%]`.
- `tab:cross-model-*` — mean GES column becomes `28.3 ± 4.1`.
- FPR table — replace "0 false positives" with "0 / 100 [0, 3.6% upper]".

Without CIs a reader looking at 5/12 vs 3/12 sees a 17pp drop and assumes it's real. With CIs they see overlapping intervals and judge accordingly. This is the cheapest way to bring the paper's claims into calibration with the data.

**Implementation:** single Python helper `compute_wilson_ci(k, n)` called from whatever script generates the table LaTeX. Add it alongside the existing table-generation code in the paper's data pipeline.

### 7.6 Updated execution order

```
P0.1 Fargate SHA ─┐
P0.2 clean-checkout gate ─┤
P0.3 Bedrock invocation fields ─┘
         ↓
      A0 probe (40 calls, 20 min)  ──> decide A1 batching strategy
         ↓
      A1 bulk dispatch
```

Total additional cost vs the original 2026-04-18 plan:
- P0.3: ~15 min code.
- A0: ~40 judge calls + flag plumbing (~40 min incl. analysis).
- A4 bump: +120 agent runs (~3 h wall-clock, runs overnight alongside A1).
- Paper CI helper: ~1 h script + table-regen.

Day-1 engineering estimate goes from ~½ day to ~¾ day. Paper-grade confidence in the resulting numbers goes from "point estimates with a narrative" to "point estimates with CIs and a noise-floor reference."

---

## 8. Token-based efficacy analysis

### 8.1 Motivation

Comparing judge efficacy by effort *label* ("medium" vs "high") is lossy: the same label consumes different token volumes on different models, and different dollar cost per case. Anthropic's own agentic-coding chart plots score against total tokens — score vs `{low, medium, high, xhigh, max}` points joined by a curve, one curve per model family — and the headline is that Opus 4.7 Pareto-dominates Opus 4.6 at every token budget. We should produce the equivalent for adversarial judging. If the shape inverts (Opus 4.7 underperforming Sonnet 4.6 at every token budget on adversarial cases), that's a publishable cross-workload finding; if it matches, it triangulates the coding-task result.

The effort-label axis is also hiding non-monotonicity. The 2026-04-18 xhigh run (175/480 at Opus 4.7, N=40) sits between high and max on effort but above both on catch rate — inconsistent with a monotonic "more thinking hurts" story. Plotting against tokens may or may not remove the non-monotonicity; either way the token-axis version is what operators actually care about.

### 8.2 C1 — per-call token capture (shipped b50ceb3)

Landed. `bedrockChat` now surfaces `{ inputTokens, outputTokens, totalTokens, cacheReadInputTokens?, cacheWriteInputTokens? }` from the Converse `usage` object. Plumbed through `JudgeVerdict` into per-rep and per-case result fields on both `test-adversarial-judge.ts` and `test-pipeline-e2e.ts`. Every run from this commit onward carries token-per-call provenance.

Fail-soft path (Bedrock outage) leaves token fields undefined — no successful call means no tokens to attribute. That means token analysis must filter for cases with defined token fields; the Python snippet from Section 7.5 already does the analogous thing for build-info.

### 8.3 Validation gate before A1 bulk dispatch

**A1 must not dispatch until C1 is smoke-validated on a live Bedrock call.** The Converse API's treatment of thinking tokens is undocumented in the SDK docs we rely on — Bedrock may roll thinking into `outputTokens`, may expose a separate field, or may vary by model. The bulk A1 run is 3,120 judge calls; discovering token fields are empty after the fact is expensive.

**Smoke test (5 min):**
```bash
npx tsx src/test-adversarial-judge.ts \
  --model "Claude Opus 4.7" --effort medium --cases adv-5 --repetitions 2
```

**Pass criteria:**
1. `cases[0].reps[0].inputTokens` is present and > 0.
2. `cases[0].reps[0].outputTokens` is present and > 0.
3. `cases[0].meanTotalTokens` is present and > 0.
4. Comparing `reps[0].outputTokens` to the same call at `effort=none`: the medium value should be meaningfully higher (thinking tokens add output length). If they're identical, thinking may not be surfaced in `outputTokens` at all.

**If pass criteria 1–3 fail:** extend `bedrockChat` to dump the raw `usage` block for a single call so we can see what fields Bedrock is actually returning, then map the right field. Gate A1 on this.

**If criterion 4 fails** (effort has no effect on reported outputTokens): thinking tokens are probably hidden from Converse's `usage`. Options — (a) fall back to latency as the axis (wall-clock `durationMs` is already captured), (b) add a direct Anthropic SDK path for token accounting. Either is an acceptable fallback; don't block A1 on it, but flag in the paper.

**Secondary probe** (run if criterion 4 fails):
```bash
aws bedrock-runtime converse --region eu-west-2 \
  --model-id 'eu.anthropic.claude-opus-4-7' \
  --messages '[{"role":"user","content":[{"text":"count to 3"}]}]' \
  --inference-config '{"maxTokens":200}' \
  --additional-model-request-fields '{"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"}}' \
  --output json | jq .usage
```
See if `usage` exposes any field beyond `inputTokens`/`outputTokens`/`totalTokens`. Directly tells us what to extract.

### 8.4 C2 — token-vs-catch Pareto plot

Once A1 lands with token telemetry:

**Analysis script (`scripts/token-pareto.py`, ~1 h):**
- Ingest every `adversarial-judge-*.json` from the A1 batch that has non-zero `tokens.meanTotalPerCall`.
- Aggregate: for each (model, effort), compute pooled catch rate, Wilson CI, mean input tokens/case, mean output tokens/case, mean total tokens/case.
- Emit three plots:
  - **Primary:** x=meanTotalTokens/case, y=catchRate, one line per model, effort labels on points. Wilson CI as vertical error bars. Direct Anthropic-chart analogue.
  - **Decomposition:** x=meanOutputTokens/case (proxy for thinking+response output), y=catchRate. Distinguishes "effort increases output tokens which hurts catching" vs "effort increases output tokens which helps catching".
  - **Cost-frontier:** x=$/case at each model's Bedrock input/output rate, y=catchRate. This is the deployment-relevant version and replaces the current effort-indexed cost estimates in `tab:judge-cost`.

**Decision rules from the plot:**
- If Sonnet 4.6 `none` is on the Pareto frontier (strictly dominates Opus 4.7 medium on both tokens AND catch rate): confirmed, recommend Sonnet 4.6 `none` as judge. Paper recommendation unchanged from Section 6.2.
- If Opus 4.7 at any effort appears on the frontier: re-evaluate the judge recommendation. Unlikely given current 5/12 vs 6/12 gap, but worth checking once CIs are tight.
- If the frontier shape differs materially between standard and adversarial cases (Opus ahead on standard hijacks, Sonnet ahead on adversarial): report both frontiers in the paper and structure the recommendation around expected workload mix.

### 8.5 C3 — paper cost table becomes a cost curve

Current `tab:judge-cost` in `p15.tex` is a single flat-cost number per effort level derived from assumed token usage. With C1+C2 data, replace with:

- **Table cells:** mean input/output tokens per judge invocation (with 95% CI), per (model, effort), measured from the A1 batch.
- **Derived column:** $/case computed from per-model Bedrock rates × measured mean tokens.
- **Accompanying figure:** the C2 cost-frontier plot (3rd one), placed next to `tab:judge-cost`.

This also lets Section 7.4 honestly answer "how much does the defence cost" with measured numbers rather than estimates. About ~2 h once the A1 data is in hand.

### 8.6 Updated execution order (incorporating Section 8)

```
C1 token capture (SHIPPED b50ceb3)
     ↓
8.3 smoke test (5 min) ── fail → raw-usage probe → fix bedrock-client.ts
     ↓
P0.1–P0.3, P0.2 gate, A0 variance probe (Section 7.3)
     ↓
A1 bulk dispatch WITH TOKEN TELEMETRY
     ↓
     ├─ C2 Pareto plot (~1 h)
     ├─ B2/B4/B5/B6 (Section 4)
     └─ C3 paper cost-curve revision (~2 h)
```

Additional cost over Section 7.6: **~3 h analysis + validation work total**, spread across Day 2 PM and Day 3. The A1 compute cost doesn't change — token fields are a byproduct of calls we're making anyway.

**The one place this can go wrong:** if the smoke test in 8.3 returns zero tokens and the fallback workarounds take longer than half a day, delay A1 until resolved. Running A1 without token data forecloses C2/C3 and forces a re-run later, which is a worse outcome than a half-day delay to fix the pipeline now.

---

## 9. Follow-up — Opus 4.7 thinking-token visibility (blocks C2/C3)

### 9.1 Problem

The A1 N=20 data (2026-04-18) validated token capture for Sonnet 4.6 and Haiku 4.5: output tokens scale clearly with effort (e.g. Haiku `none` → `high`: 72 → 765, Sonnet `none` → `medium`: 81 → 396). **Opus 4.7 doesn't show the same scaling.** Observed `meanOutputPerCall` across efforts:

| Opus 4.7 Effort | μoutput | μtotal | Comment |
|---|---|---|---|
| none | 97 | 935 | baseline |
| medium | 75 | 913 | *lower* than none |
| high | 91 | 930 | flat |
| xhigh | 129 | 967 | modest bump |
| max | 516 | 1354 | outlier — sometimes bumps |

Sonnet/Haiku respond to effort with 5–10× output-token increases; Opus 4.7 at `high` catches 28% of adversarial cases but reports only 91 output tokens per call — implausible given the model is clearly producing more reasoning than that. Smoke-test criterion 4 of §8.3 (effort visibly increases outputTokens) fails cleanly for Opus 4.7.

**Consequence:** any Opus 4.7 cost or Pareto claim using outputTokens as a compute proxy will understate Opus 4.7's actual compute consumption. The paper's Section 7.4 cost table and the C2 token-vs-catch Pareto plot both become unreliable for Opus 4.7 rows until we know what we're missing.

### 9.2 Hypotheses

In rough order of likelihood:

**H1: adaptive-thinking tokens are in a separate response field we're not reading.** Anthropic-native API exposes `usage.cache_creation_input_tokens` and may have a distinct `thinking_output_tokens` or equivalent for extended thinking. Bedrock's Converse mapping may surface these under `additionalModelResponseFields` or an Anthropic-specific extension block, not inside `usage.outputTokens`.

**H2: Bedrock collapses adaptive-thinking into `outputTokens` but applies an Opus-specific multiplier.** Unlikely (no precedent in docs), but would explain the flat output counts if adaptive-thinking tokens are multiplied out of the per-call count.

**H3: Adaptive-thinking on Opus 4.7 genuinely uses fewer output tokens than budget-tokens thinking on Sonnet/Haiku** — the model's thinking may be internal-only without token-level accounting exposed through Converse at all. In that case, there's no field to read.

**H4: Bedrock is billing the thinking tokens but not returning them in `usage`** — the AWS Cost Explorer / CloudWatch side has the numbers; the API response doesn't.

### 9.3 Investigation steps

**Step 1 — capture a raw Converse response.** ~5 min, gates everything else:

```bash
aws bedrock-runtime converse --region eu-west-2 \
  --model-id 'eu.anthropic.claude-opus-4-7' \
  --messages '[{"role":"user","content":[{"text":"Count to 5 and explain your reasoning step by step."}]}]' \
  --inference-config '{"maxTokens":2000}' \
  --additional-model-request-fields '{"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}' \
  --output json > /tmp/opus-raw.json

jq '{ usage, additionalModelResponseFields, output_structure: .output.message.content | map(keys) }' /tmp/opus-raw.json
```

**Decision rule on the output:**
- If `usage` has a field beyond `inputTokens` / `outputTokens` / `totalTokens` (e.g. `thinkingTokens`, `reasoningTokens`, `cacheCreationInputTokens`): extend `bedrock-client.ts` to surface it. (~15 min)
- If `additionalModelResponseFields` contains token breakdowns: parse it, surface it. (~30 min, new field plumbing through `JudgeVerdict`)
- If neither: confirms H3 or H4. Move to Step 2.

**Step 2 — check the reasoningContent block token count.** Bedrock surfaces thinking text under `output.message.content[].reasoningContent.text`. We can *estimate* thinking tokens by tokenising that text:

```ts
// In bedrock-client.ts, after extracting `thinking`:
// Use a simple approximation: 1 token ≈ 4 characters for English.
const estimatedThinkingTokens = thinking.length > 0 ? Math.ceil(thinking.length / 4) : 0;
```

Not as good as a Bedrock-reported count, but better than nothing. Only run this if Step 1 confirms no field. Note it as an approximation in the paper.

**Step 3 — (H4 only) if Converse genuinely doesn't expose thinking tokens at all.** Two fallback paths:

a. **Direct Anthropic SDK call** — add a `--use-anthropic-api` flag to `test-adversarial-judge.ts` that bypasses Bedrock and uses the Anthropic SDK, which exposes the full `usage` structure including thinking tokens. Scoped as a parallel code path, not a replacement; only enabled when the env has `ANTHROPIC_API_KEY`. Cost: ~2 h code. Risk: introduces a second SDK dependency path.

b. **Latency as the axis** — use `durationMs` instead of token count for the Pareto plot. Already captured. Not comparable cross-model (Bedrock throughput varies by region and load), so the chart legend has to note "latency at eu-west-2 on <date-range>". Cheap fallback but makes the paper claim weaker.

**Step 4 — paper documentation.** Regardless of outcome, add a subsection to §7.4 of `p15.tex`:
- If Step 1 finds the field: "Opus 4.7 thinking tokens are reported in Bedrock's X field rather than outputTokens. Our token accounting aggregates both."
- If Step 2 is the workaround: "Opus 4.7 thinking tokens are not directly reported by Bedrock's Converse API; we estimate them from the `reasoningContent` text length at 4 chars/token. Results should be treated as lower-bound estimates for Opus 4.7 cost."
- If Step 3a is used: "Opus 4.7 cost figures derived from direct Anthropic API calls; Bedrock Converse does not expose thinking tokens at the usage level."
- If Step 3b: "Opus 4.7 compute cost reported as latency rather than tokens due to Bedrock Converse not exposing thinking tokens."

### 9.4 Impact on Section 8 deliverables

- **C2 Pareto plot:** blocked on resolution. Plot Sonnet 4.6 and Haiku 4.5 now; add Opus 4.7 rows after fix.
- **C3 paper cost table:** blocked on resolution for Opus 4.7 rows. Sonnet/Haiku numbers can ship today.
- **A1 dataset:** not re-run. Tokens for Sonnet/Haiku are valid; Opus 4.7 tokens are incomplete. If Step 1 finds the field, we may be able to retroactively re-annotate the existing JSONs from the raw Bedrock responses — but we don't currently retain those. Going forward, every post-fix run will have it.

### 9.5 Cost

- Step 1: ~5 min — one AWS call, one `jq` filter. Gates everything.
- Step 2 (if needed): ~30 min code + re-run one cell.
- Step 3a (if needed): ~2 h code + ~4 h compute for a matching Anthropic-API A1 dataset.
- Step 3b: ~15 min analysis, weakens paper claim.

**Priority:** Step 1 should run before the next A1 sweep (if any) lands with more Opus 4.7 data. Delaying doesn't hurt immediately — existing A1 data for Sonnet/Haiku is fine to analyse today; only the Opus 4.7 rows are blocked.
