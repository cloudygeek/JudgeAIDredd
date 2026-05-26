# In-flight runs — 2026-05-25 21:00 UTC

Snapshot of bedt containers still executing test cells. Captured for handoff
visibility; freshly-completed cells synced + committed up to `560ac56fd`.

## Active

| Container | RUN_ID | Model / defence / scenario | Progress | Elapsed | Rate | ETA | Projected finish (UTC) |
|---|---|---|---|---|---|---|---|
| bedt5  | `G3X-opus-4-7-T3.4-intent-tracker-20260525T130247Z` | opus-4-7 / intent-tracker / T3.3+T3.4 (n=90) | 34 / 180 | 1116m (~18.6h) | 0.03 reps/min | ~80h | 2026-05-29 15:31 |
| bedt14 | `G2-haiku-4-5-T3-C4-baseline-n90-20260524T202341Z` | claude-haiku-4-5 / C4-baseline / T3.1–T3.4 (n=90) | 329 / 360 | 2116m (~35.3h) | 0.16 reps/min | ~3.3h | 2026-05-26 10:59 |

Both running on Converse-patched test-framework images (bedt5 v0.1.447,
bedt14 v0.1.445).

## Notes

- **bedt5 pacing is healthy, not concerning.** ~33 min/rep on opus-4-7
  with intent-tracker is consistent with real multi-turn trajectories
  plus per-tool-call Dredd `/evaluate`. Initial extrapolated ETA was
  ~29h; the steadier ~80h ETA reflects warm-up convergence, not a
  problem.
- **CORRECTION re. bedt16's 42-min PromptArmor "finish".** That run is
  **POISONED, not a result.** All 180/180 runs errored with
  `API Error: 400 "thinking.type.enabled" is not supported for this
  model` and produced **0 tool calls/run**. The `GES=100 / sd=0` is the
  zero-tool-call artefact. Root cause: the bedt16 image predates the
  executor.ts Converse port (`2c643cf7b`), so opus-4-7 hit the broken
  agent-sdk thinking path. **A 40-minute walltime on this scenario set
  is the poison signature, not a fast defence.** The valid `none`
  baseline (`…225056Z`) ran ~5.5 h serial; a healthy promptarmor-obs
  re-run is expected to take 6–10 h. See
  `docs/rerun-checklist-opus-promptarmor-2026-05-26.md` for the
  pre-launch image-fix gate, smoke gate, and validation queries.
- **bedt14 nearly done.** 92% through the haiku T3 / C4-baseline cell;
  expected to land before tomorrow midday UTC.

## What's left after these two

- **bedt5 (intent-tracker)** — let finish; should be valid (image
  v0.1.447 contains `2c643cf7b`).
- **bedt14 (haiku C4-baseline)** — let finish; haiku has no thinking
  bug.
- **Opus T3.4 promptarmor-obs re-run** — required (task #134, was
  marked completed; reverted to in_progress). Cannot run until the
  image-fix gate in the re-run checklist passes. Until that re-run
  lands valid, the PromptArmor-vs-intent-tracker comparison on Opus
  T3 cannot go in the paper.
