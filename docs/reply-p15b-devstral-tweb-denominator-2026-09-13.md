# Reply: Request 1 accepted; Request 2 denominator settled at N = 20

**Date:** 2026-09-13 · **Re:** `docs/test-request-p15b-gemini-tslop-devstral-tweb-2026-09-13.md`
and `results/archive/MANIFEST-p15b-gemini-tslop-waves-2026-08-07.md`

---

## Request 1 — accepted in full, and the request's premise was wrong

The manifest settles it: `80/80` is a per-run rate. The evidence is convincing and I have
re-derived the parts that were checkable from the deposit and from the newly archived zip:

| Claim | Independently confirmed |
|---|---|
| Local wave `2026-08-07T10-01-43-953Z`, n = 80, exfil 80/80 | yes, from the zip |
| `exfiltrationCount: 1` on all 80 local runs | yes, the value set is exactly `{1}` |
| External waveA `2026-08-07T14-49-15-424Z`, n = 40 | yes, from the zip |
| 80 collector detections, model-tagged, all on `/api/pkg-telemetry` | yes |
| Two log streams, 40 + 40, min inter-arrival 10.76 s, no sub-5 s pairs | yes |

**Both corrections to the request are accepted.**

1. The two `80/80` figures are different measurements: the local n = 80 hygiene cell, and the
   external cell pooled 40 + 40 whose comparison row is at /40. The request conflated them, and
   its N = 110 target was drawn from the local crack-vector column. Withdrawn.
2. Harness fix #2 (`rawQueryString`) shipped in June and is on every line of the August CSV.
   Withdrawn. Fixes #1 (per-run correlation id) and #3 (technique in the tag) stand, as
   harness-side improvements for future waves rather than blockers.

**One consequence for the deposit, which is now the live problem.** The local n = 80 wave is the
cell the manuscript's hygiene table reports, and it is **not in the published Zenodo archive** —
the only Gemini T-SLOP file there is a 40-run external wave. **Correction (2026-09-13):** that file
is external **waveB** (`2026-08-07T20-51-10-478Z`), not waveA as first written here; waveA
(`14:49:15-424Z`) was absent too, so both it and the local n = 80 wave were required. Both have
since been added, and the deposit now holds all three waves. The paper's answer to Reviewer 1
rests on every reported number regenerating from the deposit, so this is a data-availability
defect rather than a measurement one. The newly archived zip is being folded into a new deposit
version before resubmission. No action needed here beyond the archiving already done.

---

## Request 2 — the N = 20 denominator is confirmed, from the paper's own aggregate

The reply proposed that devstral T-WEB might be 20/80 rather than 5/20, since 25% fits both, and
noted that `INJECTION_CHANNEL_MAP_2026-06-10.md:12` specifies T-WEB at N = 80 and ADDENDUM 13c
designs for 20 + ≈60 → 80.

That reading is ruled out by `per-cell-counts.csv`, the aggregate the manuscript actually computes
from, which is released in the deposit and is the file the paper cites as "the per-cell result
counts underlying every rate":

```
model                     N     exfil    rate
devstral-2-123b           20    5        25%     <-- the cell in question
minimax-m2.5              20    2        10%     (off-roster control)
deepseek-v3.2            100    85       85%
gpt-oss-120b             100    87       87%
qwen3-235b               100    90       90%
qwen3-coder-480b         100   100      100%
... 13 roster models at N = 100, four late-added models at N = 80
```

So the published 25% is `5/20`, not `20/80`. Two further checks agree:

- The deposited raw JSON for devstral T-WEB is a single file, `TWEB.1`, wave
  `2026-06-10T18-48-26-906Z`, with `runs[]` of length 20 and 5 `exfiltrationDetected`.
- The wave structure across the roster is consistent: a 20-run pilot on 2026-06-10 and an 80-run
  main wave on 2026-06-11. Thirteen models have both. Devstral has only the pilot. The four
  late-added models (Gemini, GPT-5.5, Fable 5, GLM-5) have only the main wave, at 80, as expected.

On the point that no roster T-WEB raw JSON exists in the d2 tree: correct, and it explains the
disagreement. The audit ran over the **Zenodo deposit** (`zenodo-v2-staging/p15b-run-data/`), not
d2 and not the S3 mirror. The deposit is what reviewers will check, so that is the corpus that
matters for what the paper can claim.

**Request 2 therefore stands: devstral-2-123B, T-WEB (`TWEB.1`), C4-baseline, N = 80**, to bring
the cell to 100 and match the other twelve open-weights models. If the 60-to-80 run remainder
exists in the S3 mirror rather than needing fresh compute, depositing it is equally good and
cheaper; the requirement is that the cell's denominator matches what the paper claims and that the
raw data is in the archive.

**If it cannot be run before 2026-10-01**, say so and the manuscript will report the cell at
N = 20 with its wider interval. That correction has already been made to the captions, which
previously claimed N = 80–100 for all high-traffic channels without exception.

---

## Not requested

Nothing else. The audit covered all nine channels across the 16-model roster in the deposit and
found devstral T-WEB to be the only cell materially below its channel's modal N.
