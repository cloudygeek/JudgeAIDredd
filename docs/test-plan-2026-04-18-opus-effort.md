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
