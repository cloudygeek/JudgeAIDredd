# Test 1 Re-run Instructions (with build-info provenance)

**Date:** 2026-04-18
**Context:** Every result JSON in `results/test1/` and `results/pipeline-e2e-*` predates commit `78f6b68` (build-info introduction) and so carries no provenance. Inspection found Config F (Cohere + Opus 4.7) runs with TP=4/11 alongside TP=10/11 for the same (config, effort) cell, and similarly for Config H (Cohere + Sonnet 4.6) at `high`/`medium` effort. The 4/11 runs are pre-fix artefacts (Opus 4.7 thinking-API shape prior to `b039c1a`; Sonnet thinking-budget prior to `62ab89a`). Mixing them with clean runs pollutes every downstream table in `p15.tex`.

This doc is two things:
1. How to produce build-stamped results going forward (operators and new test authors).
2. The exact re-run set needed to replace the contaminated Test 1 JSONs.

---

## 1. What "build-info" is and how it gets stamped

Commit `78f6b68` added `src/build-info.ts`, which captures:

```ts
interface BuildInfo {
  gitSha: string;       // short HEAD SHA at runtime
  gitDirty: boolean;    // true if working tree had uncommitted changes
  sdkVersion: string;   // version string from package.json
  capturedAt: string;   // ISO timestamp when build-info was resolved
}
```

### 1a. For operators: nothing to do except build from a clean checkout

Every object-shaped result writer already calls `getBuildInfo()`:
- `src/test-pipeline-e2e.ts` — pipeline-e2e-*.json
- `src/test-adversarial-judge.ts` — adversarial-judge-*.json
- `src/test-fpr.ts` — fpr-*.json
- `src/test-threshold-sweep.ts` — threshold-sweep-*.json
- `src/policy-review.ts` — policy-review-*.json

The two array-shaped runners emit a sidecar `<path>.meta.json`:
- `src/runner.ts`
- `src/runner-bedrock.ts`

Operator checklist before kicking off a run:

1. `git status` — must be clean. If `gitDirty` is `true` in the result JSON, the run's SHA alone doesn't identify the code that produced it.
2. `git log --oneline -1` — note the SHA you intend to run at.
3. `npm install` (only if `package.json` or `package-lock.json` changed since last install — otherwise the old `node_modules/` may have an older SDK than `package.json` claims).
4. Run the test.
5. Verify: `python3 -c "import json; print(json.load(open('<file>'))['build'])"`. Confirm `gitSha` matches step 2 and `gitDirty` is `false`.

If `gitSha` comes back as `"unknown"` the runner was invoked from a cwd outside the repo. `build-info.ts` runs `git rev-parse --short HEAD` with no explicit cwd — ensure the shell you launch from is inside the repo root or a subdirectory.

### 1b. For new test authors: the two patterns

**Object-shaped output** (preferred for new writers):

```ts
import { getBuildInfo } from "./build-info.js";

writeFileSync(outPath, JSON.stringify({
  build: getBuildInfo(),
  // ...everything else...
}, null, 2));
```

Put `build` first so it's visible at a glance when inspecting result files.

**Array-shaped output** (legacy; preserve downstream parsers):

```ts
import { getBuildInfo } from "./build-info.js";

writeFileSync(outPath, JSON.stringify(allResults, null, 2));
const metaPath = outPath.replace(/\.json$/, ".meta.json");
writeFileSync(metaPath, JSON.stringify({ build: getBuildInfo(), outputPath }, null, 2));
```

Don't change an existing array-shaped schema to an object-shape just to add build-info — that breaks every analysis script. Use the sidecar pattern.

### 1c. Provenance filtering at analysis time

Any script that aggregates results should reject files with missing or `gitDirty: true` build-info, or at minimum surface them as a separate bucket. Template:

```python
def is_clean(d):
    b = d.get('build') or {}
    return b.get('gitSha', 'unknown') not in ('unknown', '') and not b.get('gitDirty', True)
```

Treat "no build field" as contamination, not as "legacy clean" — there's no way to distinguish a pre-78f6b68 clean run from a post-78f6b68 dirty run without that field.

---

## 2. Test 1 re-run set

### 2a. What's contaminated

Every `pipeline-e2e-*.json` file currently on disk has no `build` field. Tagged by configuration and likely status:

| Config | Judge | Embed | Status | Action |
|---|---|---|---|---|
| A | Nemotron | nomic | Pre-build-info but Nemotron does not use thinking-API — likely fine | Re-run to get provenance. Low priority. |
| B | Nemotron | Cohere v4 | Same as A | Re-run to get provenance. Low priority. |
| C | Haiku 4.5 | nomic | No effort-related regression observed (97% flat across all runs) | Re-run to get provenance. Low priority. |
| D | Haiku 4.5 | Cohere v4 | One `high` run and one `max` run show TP=9 instead of TP=10 — within noise | Re-run at higher N. Medium priority. |
| E | Opus 4.7 | nomic | Consistent 10/11 across all clean runs, including `xhigh` | Re-run to get provenance. Low priority. |
| **F** | **Opus 4.7** | **Cohere v4** | **3 of 4 `high` runs AND 3 of 4 `medium` runs have TP=4** (pre-`b039c1a`). **Must re-run.** | **Re-run at N≥3. High priority.** |
| G | Sonnet 4.6 | nomic | Consistent 10/11 across efforts | Re-run to get provenance. Low priority. |
| **H** | **Sonnet 4.6** | **Cohere v4** | **TP=4 at `high` and `medium` on 2 runs each** (pre-`62ab89a` thinking-budget cap). **Must re-run.** | **Re-run at N≥3. High priority.** |

### 2b. The minimal re-run command

All runs must originate from a checkout at or after commit `7425128` (first SHA that gives you both build-info stamping and the `--repetitions` flag) with `git status` clean. Verify before starting:

```bash
git log --oneline -1    # expect >= 7425128
git status              # expect "nothing to commit, working tree clean"
npm install             # no-op if package-lock.json unchanged
```

Using the existing local runner:

```bash
# High priority — invalidates the paper's Config F and H accuracy numbers
./run-test1-local.sh F default,low,medium,high,max
./run-test1-local.sh H default,low,medium,high,max

# Medium priority — resolve the D high/max TP=9 vs TP=10 ambiguity
./run-test1-local.sh D default,low,medium,high,max

# Low priority — provenance-only re-runs for the configs whose current numbers
# look consistent across contaminated runs. Do these in one sweep overnight.
./run-test1-local.sh A,B,C,E,G default,low,medium,high,max
```

`test-pipeline-e2e.ts` today runs each case once per configuration per effort level (29 cases × 1 rep). For Configs F and H we want N≥3 to triangulate stochastic Bedrock behaviour — run each command three times. The resulting JSONs will be distinguishable by timestamp.

Approximate wall-clock per config × effort (29 cases × ~6 s mean latency): 3 min. Full F+H at 5 efforts × 3 reps = 30 runs × 3 min = **~90 min wall-clock**.

### 2c. Acceptance criteria

A re-run batch is acceptable for the paper if:

1. Every new file has `build.gitSha ≠ "unknown"` and `build.gitDirty == false`.
2. For Configs F and H at `medium`/`high`, TP is consistent across 3 independent runs (variance ≤1 TP).
3. No single run returns `TP < 8` for Configs C–H (the stable operating range). A TP < 8 result indicates the thinking-budget or adaptive-thinking path has regressed again — stop, investigate, don't bulk the data.

### 2d. Archival of the contaminated set

Once the re-runs are in, don't delete the old files — move them under a dated `archive/` directory so future analysis scripts skip them but the history is preserved for auditing:

```bash
mkdir -p results/archive/pre-build-info-2026-04-18
git mv results/pipeline-e2e-*.json results/archive/pre-build-info-2026-04-18/
git mv results/test1/pipeline-e2e-*.json results/archive/pre-build-info-2026-04-18/
```

(Leave `results/test1/test1.log` in place — it's a runner log, not a result file.)

Commit message suggestion:
```
Archive pre-build-info Test 1 results

These pipeline-e2e JSONs were produced before commit 78f6b68 (build-info
introduction) and cannot be distinguished between pre-fix Opus 4.7 runs
(contaminated by b039c1a thinking API mismatch) and post-fix runs. Per
docs/rerun-instructions-test1-2026-04-18.md they're replaced by re-runs
that carry build.gitSha provenance.
```

### 2e. What about Tests 2–9?

Tested for provenance:
- **Test 2 / runner-bedrock runs:** sidecar `.meta.json` files. Any run after `78f6b68` has one. Grep `results/` for `*.meta.json` to confirm coverage.
- **Test 3a (robustness):** `results/test3a/bedt3-*`, `results/test3a/bedt4-a5-*` subdirectories have `.meta.json` sidecars for every result. Root-level `results/test3a/robustness-*` files predate build-info and should be treated as pre-provenance — check the aggregate against `bedt3` before trusting.
- **Test 7 (cross-model):** `results/test7/cross-model-claude-opus-4-7-*.meta.json` sidecars present — Opus 4.7 cells are clean.
- **Test 8 (adversarial):** 1 of 130 files has build info (the A2 Opus 4.7 none result at `2026-04-17T22:19`). Everything else predates 78f6b68.
- **Test 9a (latency):** `results/test9a/20260417T150552Z/*.meta.json` sidecars cover the clean Opus 4.7 + Sonnet 4.6 cells.

Test 8 full re-run is already scoped in Phase A1 of `test-plan-2026-04-17-opus-effort.md` (20 reps × 3 Anthropic models × 4 effort levels, using the new `--repetitions` flag). Running the Phase A1 plan automatically gives that suite build provenance.

---

## 3. Verification afterwards

A quick integrity sweep you can run once re-runs complete:

```bash
# Confirm every new pipeline-e2e file has non-stale build-info
python3 - <<'PY'
import json, glob
for f in sorted(glob.glob('results/pipeline-e2e-*.json') + glob.glob('results/test1/pipeline-e2e-*.json')):
    d = json.load(open(f))
    b = d.get('build', {})
    sha = b.get('gitSha','(none)')
    dirty = b.get('gitDirty')
    status = 'OK' if sha not in ('unknown','(none)') and dirty is False else 'CHECK'
    print(f"{status:<6} {f[-60:]:<60} sha={sha} dirty={dirty}")
PY
```

If every row is `OK`, downstream analysis scripts can trust the aggregate.

---

## Summary

**Operator action today:** re-run Configs F and H at 3 reps × 5 effort levels from the current tip; optionally batch-run A/B/C/D/E/G for provenance. Verify every output file has `build.gitSha` set and `gitDirty: false`. Archive the pre-build-info JSONs.

**Developer action for new tests:** inject `getBuildInfo()` at the top of the output object, or drop a sidecar `.meta.json` for array-shaped writers. Reject `gitDirty: true` runs at analysis time.
