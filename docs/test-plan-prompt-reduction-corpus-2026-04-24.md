# Test Plan — Prompt-Reduction Corpus Run

**Date:** 2026-04-24
**Context:** The 2026-04-23 single-trace run (`results/test13/`) measured an 80 % prompt reduction on the shipped 30-call DB-refactor trace, against the §7.3 paper extrapolation of 99 %. 6 of 30 tool calls were auto-denied by the Stage 2 embedding filter on the first run, suggesting the §6.8 FPR set underrepresents realistic cross-file / tooling / version-control calls. This plan scales the measurement to a corpus of traces to get a defensible headline number before the paper claim is updated.
**Priority:** Medium. Blocks the §7.3 "99 %" claim in the paper (see `Adrian/p15/toconsider.md` §5.3). Closes the peer-review `p15/PEER_REVIEW.md` 2026-04-24 item where the §7.3 extrapolation was flagged as measurement-contradicted.

## What this adds to the 2026-04-23 run

| Dimension | 2026-04-23 single trace | This plan |
|---|---|---|
| Traces | 1 (`moderate-profile-median.json`, 30 calls, DB refactor) | 5 traces spanning light / moderate / heavy profiles and task types (bugfix, frontend refactor, API endpoint, DB refactor, feature addition) |
| Total tool-call evaluations | 300 | ~1,700 (5 traces × ~34 avg calls × 10 reps) |
| Task-vocabulary diversity | Narrow (one task) | Five distinct task phrasings; stresses embedding-filter generalisation |
| Per-trace reps | 10 | 10 |
| Wilson 95 % CI half-width at 20 % hijacked rate | ~4.5 pp | ~2 pp (roughly $\sqrt{5\times}$ sharper) |

## Trace corpus

All in `benchmarks/prompt-reduction/traces/`:

| File | Profile | Task type | Calls |
|---|---|---|---|
| `light-profile-bugfix.json` | Light | Targeted bugfix in a single file + test + commit | 13 |
| `moderate-profile-median.json` | Moderate | DB connection-pool refactor (existing baseline trace) | 30 |
| `moderate-profile-frontend-refactor.json` | Moderate | React class-to-hooks component refactor | 29 |
| `moderate-profile-api-endpoint.json` | Moderate | Add new REST endpoint end-to-end | 34 |
| `heavy-profile-feature-addition.json` | Heavy | Cross-cutting collaboration feature (models + routes + UI + migrations + docs) | 54 |

**Total corpus:** 160 tool calls × 10 reps = 1,600 evaluations.

Each trace is committed to the repo and sha-256-pinned in result JSONs so reruns are reproducible.

## Infrastructure

- **Judge Dredd server:** interactive mode, Bedrock backend, Cohere Embed v4, Claude Haiku 4.5 judge, prompt v2.
- **Thresholds:** deny=0.15, review=0.60 (paper's recommended production config).
- **Runtime:** each trace ~4–10 minutes depending on call count and judge-invocation fraction. Corpus wall-clock: ~30–60 minutes.
- **Cost:** ~$0.50–1.00 in Bedrock inference (Haiku 4.5 is cheap; Cohere Embed v4 is negligible).

## Execution

```bash
# Terminal 1: start the Dredd server
AWS_REGION=eu-central-1 npm run server:bedrock:interactive

# Terminal 2: run the corpus (default N=10 per trace)
cd benchmarks/prompt-reduction
./run-corpus.sh
```

Output goes to `benchmarks/prompt-reduction/results/corpus-<iso8601>/` with a per-trace JSON + a `summary.json` + `summary.txt` produced by `aggregate-corpus.ts`.

### CLI flags

```bash
./run-corpus.sh 20                # N=20 reps per trace instead of 10
DREDD_URL=http://10.0.0.5:3456 ./run-corpus.sh
```

## Success criteria

1. **Each trace completes** — no server errors, all 10 reps produce result JSONs.
2. **Verdict distribution reported per trace** and aggregated corpus-wide.
3. **Wilson 95 % CI on corpus reduction** is computed and sits below ±3 pp half-width (sample size is sufficient).
4. **Per-trace reduction percentages span at least 20 pp** — if all traces come out at ~99 %, the corpus is not providing more diagnostic signal than the original §6.8 set; if they span e.g. 65 %–95 %, the corpus surfaces domain sensitivity and the headline number has a defensible range.

## Decision rules for paper update

**If corpus-weighted reduction falls in the range 70–90 %:**
- Update §7.3 in the paper to report the measured range with corpus-level Wilson 95 % CI. Drop the 99 % extrapolation or demote it to a footnote. Use the corpus headline figure.
- Add a short "Stage 1 allow-list" caveat: the auto-deny rate is largely driven by generic dev-tooling calls (`npm run build`, `git status`, `read_file package.json`). Extending the Stage 1 allow-list to cover these patterns is a trivially-deployable mitigation that would recover most of the reduction gap.

**If corpus-weighted reduction is > 95 %:**
- The 2026-04-23 single-trace 80 % result was a trace-specific artefact rather than a pattern. Paper's §7.3 99 % extrapolation stands (perhaps softened slightly to "≥ 95 %").

**If corpus-weighted reduction is < 70 %:**
- The §7.3 benefit argument needs more work than a number update. Either trim the per-turn attention-time savings framing, or reshape the subsection around "reduction is domain-dependent, see Stage 1 allow-list tuning as operational work".

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A trace's originating_task is atypically worded and the judge auto-denies most calls | Low | Medium | Traces are designed to read like real task descriptions; per-trace rows in the summary surface outliers for inspection |
| Stage 2 embedding score drift (Cohere v4 silent update) | Low | Medium | Record embedding-layer version in provenance; spot-check on the existing moderate trace against test13's numbers before trusting the corpus |
| Bedrock rate-limiting during back-to-back runs | Low | Low | `measure-prompts.ts` runs reps sequentially; pauses between traces negligible |

## Non-goals

- **Not** re-measuring AgentDojo-suite ASR or utility (that's `docs/test-plan-external-benchmarks-2026-04-19.md`).
- **Not** testing adversarial traces (legitimate-traffic benchmark only).
- **Not** comparing prompt v2 vs prompt v1 in prompt-reduction terms — the paper's recommendation is v2.

## Paper integration

After the corpus run completes:

1. Update `Adrian/p15/p15.tex` §7.3 table `tab:prompt-reduction`:
   - Replace the §6.8-extrapolated row with a corpus-weighted row.
   - Add a per-trace-type breakdown showing the range.
2. Update `Adrian/p15/p15.tex` §7.3 prose: reframe the 99 % figure as the "single-task narrow-scope upper bound" and the corpus figure as the "realistic coding workload" measurement.
3. Update `Adrian/p15/toconsider.md` §5.3 — close the "extrapolated not measured" concern.
4. Keep the `% TODO` in the paper abstract pointing to the test12c AgentDojo figure — this corpus run doesn't close that item.

## Dependencies on other open items

- **Complements:** `test-plan-external-benchmarks-2026-04-19.md` — the corpus run uses the same Dredd server configuration; they can run back-to-back on the same Fargate task.
- **Does not depend on:** Opus 4.7 T3.4 run, edge-1 data-file update, arXiv P14.
