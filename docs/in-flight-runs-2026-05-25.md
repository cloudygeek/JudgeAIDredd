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

- **bedt5 pacing concern.** Initial pace was ~0.08 reps/min (29h ETA at the
  start of the run); current rate has slowed to ~0.03 reps/min. ~33 min/rep
  on average is consistent with intent-tracker calling Dredd `/evaluate` per
  tool call across multi-turn opus-4-7 trajectories. By contrast, the same
  T3.3+T3.4 scenario set on **promptarmor-obs** (bedt16) finished 180 reps
  in 42 minutes — promptarmor only screens external content, while
  intent-tracker invokes the LLM judge per tool call.
- **bedt14 nearly done.** 92% through the haiku T3 / C4-baseline cell;
  expected to land before tomorrow midday UTC.

## What's left after these two

Per task #71 the Opus G3X T3.4 trio (none / intent-tracker / promptarmor-obs)
will all be present once bedt5 lands. No other cells outstanding.
