# P14 request: produce the bimodality figure from REAL per-rep data

**Date:** 2026-05-31 (peer-review pass)
**Relates to:** reviewer gaps G5 (`p14-reviewer-gaps-2026-05-22.md`), peer-review
points M2 (reproducibility) and M3 (calibrate headline statistics to evidence).
**Owner:** dredd measurement pipeline (this repo).

## Decision

The manuscript's Figure for **Finding 1 (goal-hijacking outcomes are bimodal)**
must be produced by the dredd pipeline **from real per-repetition data**, not
hand-drawn from the reported summary statistics.

## Background

During the 2026-05-31 peer-review pass a stop-gap figure was generated for the
manuscript at `Paper14/figures/fig_bimodality.pdf` (+ `fig_bimodality.py`).
**It is drawn from the reported mixture parameters only** — 31 runs at GES 0 +
59 at GES 100, reconstructing weights (0.34, 0.66); annotated mean 65.6, 95% CI
[55.4, 75.7], Hartigan D=0.172, ΔBIC≈1797. The script header and an on-figure
footer state this explicitly. It is an honest illustration and a **placeholder
to be replaced**, because it is not backed by raw runs — which is exactly the
integrity gap G5 records ("Finding 1 numbers were computed offline and pasted
into the manuscript; the computation is not reproducible from the repo").

An exhaustive search this session (~86k–87k result JSONs under `results/` and
`benchmarks/`) did **not** locate the original Sonnet V1 (T3/C1) and V2 (T3/C2a)
n=90 per-rep arrays behind Finding 1. The nearest on-disk corpora are a Haiku
T3/C1 n=90 set (different model, GES ∈ {0, 33.3, 100}, means ~25–49) and an
AgentDojo-derived Sonnet T3.4 pooled set (n=340) whose own README disclaims
being V1/V2.

## Definition of done

- [ ] Per-rep GES arrays for **V1 (T3/C1)** and **V2 (T3/C2a)**, n=90 each,
      persisted under `results/` as JSON — one record per repetition with at
      least the `(D,P,E,S)` bits and the derived per-run GES ∈ {0, 33.3, 100}.
      Prefer locating the *original* records; re-run only if they are truly gone.
- [ ] `compute-bimodality.py` (this repo) / `a1_bimodality.py` (shipped in the
      Zenodo `data/analysis/` set) run against that JSON and regenerate D, p,
      GMM component means/weights, and ΔBIC — **confirming** the manuscript's
      Finding 1 values, or reporting corrected values if they differ.
- [ ] Histogram regenerated **from the real per-rep arrays**, overwriting
      `Paper14/figures/fig_bimodality.pdf`, preserving: paired panels (bimodal
      T3 vs a unimodal well-defended technique, e.g. T8), mean + 95% CI
      annotation, colourblind palette (red `E74C3C` / green `27AE60` / amber
      `F39C12`), IEEE single-column width (~3.4 in), vector PDF + reproducible
      script checked in.
- [ ] If recomputed statistics differ materially from the manuscript's reported
      values, raise a manuscript-correction note (this is the M3 point — the
      headline numbers must match what is reproducible from data).

## Why this matters

Producing the figure from real data simultaneously (a) gives the paper a genuine
results visual instead of a fitted illustration, (b) makes Finding 1 reproducible
end-to-end (closes G5), and (c) directly answers reviewer M2 (reproducibility)
and de-risks M3 (the headline statistics become checkable).

## Caveat for whoever runs this

Inference temperature is not controllable on the Claude API for agentic
deployments (paper limitation L4), so a fresh V1/V2 re-run will not reproduce the
original per-cell values bit-for-bit. It should, however, reproduce the **bimodal
shape** (mass at GES 0 and 100, near-empty 34–89 band) and dip-test significance.
