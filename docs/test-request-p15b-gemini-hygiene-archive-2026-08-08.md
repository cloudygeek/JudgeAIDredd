# Test requirement — archive the missing Gemini hygiene + README-egress raw JSONs

**Date:** 2026-08-08
**Requested by:** p15b-measurement revision (CYSE-D-26-01005, due 2026-08-19).
**Priority:** HIGH — resubmission blocker. Three cells the manuscript reports have
**no auditable raw data in the repo**, only summary numbers in
`results/INJECTION_CHANNEL_MAP_GEMINI_2026-08-03.md` (Section 2b, "added 2026-08-07,
1,100 runs").

## The gap

Two independent verifications against the archived zips confirm that the 2026-08-07
Gemini wave was **summarised but only partly archived**. Present and verified:
TEGRESS-CMD (command-output egress) and T-SLOP-external are in
`p15b-tegresscmd-tslop-external-2026-08-07.zip`. **Absent from every zip and from
disk** (0 files found):

1. **T-STAGE** (Gemini) — manuscript Table 3 = `160/160`, `scriptAudited=false 160/160`
   (TSTAGE.1 + TSTAGE.2, N=80 each).
2. **T-EMIT** (Gemini) — manuscript Table 3 = `80/80` (TEMIT.2), plus TEMIT.1 `0/80`.
3. **T-EGRESS README-delivered** (Gemini) — manuscript Section 4.2 = `0/80` on each of
   image-GET / git-push / DNS / tool-argument, `agentDetected 79-80/80`. (This is the
   instruction-borne egress axis, distinct from the archived command-output TEGRESS-CMD.)

The manuscript states the paper's per-cell data is released, so a Table 3 row and a
Section 4.2 claim whose raw JSONs are not in the release is a reproducibility hole a
reviewer will (rightly) flag.

## What to do

Pull these Gemini per-run JSONs from the boxes / S3 (they existed when the analysis
doc was written — same 2026-08-07 wave that produced the archived TEGRESS-CMD / T-SLOP
files) and archive them exactly as the other waves:

- a zip under `results/archive/` + a `MANIFEST-*.md` with a **SHA-256** and provenance
  (model ID, backend, runId, n per cell);
- **and confirm from the raw `runs[]` that the summary numbers recompute**: T-STAGE
  160/160 exfil with `scriptAudited=false` on all 160; T-EMIT TEMIT.2 80/80 and
  TEMIT.1 0/80 `maliciousArtifactEmitted`; T-EGRESS 0/80 per egress with the stated
  `agentDetected` counts. Report the recomputed counts in the manifest.

If any of these raw JSONs no longer exist on the boxes, say so explicitly — in that
case the affected cells must be **re-run** (same fixed build, `C4-baseline`,
`gemini-3.1-pro-preview`, Vertex `global`) before resubmission, not shipped from the
summary alone.

## Note

The **T-SLOP** external `80/80` and the **Section 4.2 image-GET external validity**
numbers are legitimately CloudWatch-scored (the in-harness canary cannot see an
off-box POST) and are covered by a Limitations caveat; please also archive the
**collector-side detection log** (the `CANARY_DETECTED` CloudWatch export +
`EXTERNAL_CANARY_VALIDITY_2026-06-12.md` + `pingTest-canary-detections-2026-06-13.json`)
so those external cells are reproducible from a released artifact rather than
"available on request".
