# Sonnet-4.6 / T3.4 — pooled wrapped JSONs

Pool date: 2026-05-23. Two cells (`none`, `intent-tracker`) each containing
n=340 reps of T3.4-only Sonnet-4.6 sophisticated runs, wrapped in the
test29-style `{runs: [...]}` envelope so `scripts/compute-bimodality.py`
and `scripts/ges-decomp.py` can score them directly.

The G3 reviewer ask (R2.3, `docs/p14-reviewer-gaps-2026-05-22.md` §G3)
called for "Sonnet T3 variance is already in `results/test29/29a/` (n=90)" —
that turned out to be wrong: `results/test29/29a/29a-T3.3-T3.4/` only
contains gpt-4o-mini and qwen3-235b. The actual Sonnet T3.4 corpus lives
across the AgentDojo cross-model sweeps and `test16`. Pooled here so the
Sonnet rows of the manuscript Table 8' replacement reuse the same JSON
shape and scoring scripts as the freshly-collected G3 cells.

## Source files

`none` (340 reps across 17 files):

- `results/agentdojo-t20t21-baseline/cross-model-claude-sonnet-4-6-none-sophisticated-*.json` (8 files × 20 reps T3.4 = 160)
- `results/agentdojo-t20t21-defended-a/cross-model-claude-sonnet-4-6-none-sophisticated-*.json` (4 files × 20 = 80)
- `results/agentdojo-t20t21-defended-b/cross-model-claude-sonnet-4-6-none-sophisticated-*.json` (4 files × 20 = 80)
- `results/test16/20260424T131037Z/cross-model-claude-sonnet-4-6-none-sophisticated-*.json` (1 file × 20 = 20)

`intent-tracker` (340 reps across 17 files):

- Same path layout, `intent-tracker` filter on filename.

## Headline numbers (T3.4 only)

| Cell | n | mean GES | 95% CI | Hijack% | Stealth% | dipD | dipP | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| sonnet-4-6 / none           | 340 | 31.67 | [30.9, 32.4] | 100.0 | 5.0  | 0.025 | 0.152 | unimodal-bottom |
| sonnet-4-6 / intent-tracker | 340 | 17.65 | [15.7, 19.6] | 99.1  | 48.8 | 0.244 | <0.001 | **bimodal**   |

Sonnet's bimodality is **defence-induced**, not intrinsic. Without
intent-tracker the T3.4 distribution is unimodal-bottom (dip p=0.15);
intent-tracker enables a deflection-to-zero mode on roughly half the
attacks (cluster weights 0.49 / 0.51, means ≈0 / ≈34), producing the
bimodal split visible in earlier figures.

## Reproducing

```bash
python3 scripts/compute-bimodality.py --filter T3.4 --json out.json \
    benchmarks/test-framework/runs/sonnet-T3.4-pooled-2026-05-23/sonnet-T3.4-none-pooled.json \
    benchmarks/test-framework/runs/sonnet-T3.4-pooled-2026-05-23/sonnet-T3.4-intent-tracker-pooled.json
```

The pooling script that built these JSONs is documented inline in
`docs/g3-haiku-opus-t3-variance-payload-2026-05-23.md`.
