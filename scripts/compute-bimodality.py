#!/usr/bin/env python3
"""
compute-bimodality.py — bimodality + GMM diagnostics for test29-shape JSONs.

Walks one or more directories of test29 / test18 result JSONs and emits, per
input file, the descriptive + dip + mixture statistics needed to back the
manuscript's Finding 1 reproducibility claim and the G2 (T4) / G3 (per-model
T3) acceptance tests in docs/p14-reviewer-gaps-2026-05-22.md.

Reads the GES distribution from each file's `runs[].ges` array. The script
deliberately avoids any source-of-truth opinion about the runs — it just
emits numbers. Reviewer-facing prose lives in the manuscript.

Output: one row per input file as TSV to stdout (header on first line);
optional --json emits the same data as a list of objects to a path.

Statistics produced per cell:
  n, mean, sd, BC (SAS-style bimodality coefficient: (skew^2 + 1) /
    (kurt + 3*(n-1)^2/((n-2)*(n-3)))). BC > 0.555 is the SAS heuristic
    for bimodal.
  dipD, dipP   — Hartigan dip statistic + permutation p-value (10000 perms).
                 If the `diptest` package isn't available, both fall back to
                 NaN with a warning on stderr.
  bic1, bic2, dBIC  — single- vs two-component Gaussian mixture BIC. Reported
                       only when scikit-learn is available; otherwise NaN.
  weights, means    — two-component GMM weights and means.
  ashmanD           — Ashman's D = sqrt(2)*|mu1-mu2|/sqrt(sd1^2+sd2^2). > 2
                      indicates clear bimodality (Ashman 1994). NaN when GMM
                      unavailable.

Usage:
  scripts/compute-bimodality.py results/test29/             # whole tree
  scripts/compute-bimodality.py results/test29/29a results/test18-sonnet-baseline-n20/
  scripts/compute-bimodality.py --filter T3.4 results/test29/
  scripts/compute-bimodality.py --json out.json results/test29/
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any


def _load_runs(path: Path) -> list[dict[str, Any]] | None:
    """Return the runs list from a test29 / test18 / phaseE JSON, or None
    if the file isn't in that shape."""
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    runs = data.get("runs")
    if isinstance(runs, list) and runs and isinstance(runs[0], dict):
        return runs
    return None


def _ges_series(runs: list[dict[str, Any]]) -> list[float]:
    """Pull GES values from the runs list. Skips runs without `ges`."""
    out: list[float] = []
    for r in runs:
        v = r.get("ges")
        if isinstance(v, (int, float)) and math.isfinite(v):
            out.append(float(v))
    return out


def _moments(xs: list[float]) -> tuple[float, float, float, float]:
    """Return (mean, sd, skew, excess_kurtosis) using sample formulas
    (skew: g1 with bias; kurt: g2 = m4/m2^2 - 3, biased). Matches SAS BC
    convention closely enough for the manuscript-rounding acceptance test.
    """
    n = len(xs)
    if n < 2:
        return (xs[0] if xs else 0.0, 0.0, 0.0, 0.0)
    mean = sum(xs) / n
    m2 = sum((x - mean) ** 2 for x in xs) / n
    m3 = sum((x - mean) ** 3 for x in xs) / n
    m4 = sum((x - mean) ** 4 for x in xs) / n
    sd = math.sqrt(m2 * n / (n - 1)) if n > 1 else 0.0
    skew = m3 / (m2 ** 1.5) if m2 > 0 else 0.0
    kurt = (m4 / (m2 ** 2) - 3.0) if m2 > 0 else 0.0
    return mean, sd, skew, kurt


def _bimodality_coefficient(skew: float, kurt: float, n: int) -> float:
    """SAS bimodality coefficient.
    BC = (skew^2 + 1) / (kurt + 3*(n-1)^2 / ((n-2)*(n-3)))
    > 0.555 is the SAS heuristic for bimodality."""
    if n < 4:
        return float("nan")
    correction = 3.0 * (n - 1) ** 2 / ((n - 2) * (n - 3))
    denom = kurt + correction
    if denom <= 0:
        return float("nan")
    return (skew * skew + 1.0) / denom


def _hartigan_dip(xs: list[float]) -> tuple[float, float]:
    try:
        import diptest  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        print(
            "[compute-bimodality] WARN: `diptest` package missing; "
            "dip stats unavailable. pip install diptest",
            file=sys.stderr,
        )
        return float("nan"), float("nan")
    if len(xs) < 4:
        return float("nan"), float("nan")
    d, p = diptest.diptest(np.asarray(xs, dtype=float))
    return float(d), float(p)


def _gmm_bic(xs: list[float]) -> dict[str, float]:
    """Two-component vs one-component GMM BIC + Ashman D + mixture weights."""
    out = {
        "bic1": float("nan"),
        "bic2": float("nan"),
        "dBIC": float("nan"),
        "weight1": float("nan"),
        "weight2": float("nan"),
        "mean1": float("nan"),
        "mean2": float("nan"),
        "ashmanD": float("nan"),
    }
    if len(xs) < 6:
        return out
    try:
        import numpy as np  # type: ignore
        from sklearn.mixture import GaussianMixture  # type: ignore
    except ImportError:
        print(
            "[compute-bimodality] WARN: numpy/sklearn missing; GMM stats "
            "unavailable. pip install numpy scikit-learn",
            file=sys.stderr,
        )
        return out

    arr = np.asarray(xs, dtype=float).reshape(-1, 1)
    g1 = GaussianMixture(n_components=1, random_state=0).fit(arr)
    g2 = GaussianMixture(
        n_components=2, random_state=0, n_init=10, init_params="kmeans"
    ).fit(arr)
    out["bic1"] = float(g1.bic(arr))
    out["bic2"] = float(g2.bic(arr))
    out["dBIC"] = out["bic1"] - out["bic2"]

    weights = g2.weights_.tolist()
    means = [float(m) for m in g2.means_.flatten().tolist()]
    sds = [float(math.sqrt(c[0][0])) for c in g2.covariances_.tolist()]
    order = sorted(range(2), key=lambda i: means[i])
    out["weight1"], out["weight2"] = weights[order[0]], weights[order[1]]
    out["mean1"], out["mean2"] = means[order[0]], means[order[1]]
    sd_sq_sum = sds[0] ** 2 + sds[1] ** 2
    if sd_sq_sum > 0:
        out["ashmanD"] = math.sqrt(2.0) * abs(means[0] - means[1]) / math.sqrt(sd_sq_sum)
    return out


def analyse_file(path: Path) -> dict[str, Any] | None:
    runs = _load_runs(path)
    if runs is None:
        return None
    xs = _ges_series(runs)
    if not xs:
        return None
    mean, sd, skew, kurt = _moments(xs)
    bc = _bimodality_coefficient(skew, kurt, len(xs))
    dipD, dipP = _hartigan_dip(xs)
    gmm = _gmm_bic(xs)
    rec: dict[str, Any] = {
        "file": str(path),
        "n": len(xs),
        "mean": round(mean, 4),
        "sd": round(sd, 4),
        "skew": round(skew, 4),
        "kurt": round(kurt, 4),
        "BC": round(bc, 4) if math.isfinite(bc) else None,
        "dipD": round(dipD, 4) if math.isfinite(dipD) else None,
        "dipP": round(dipP, 6) if math.isfinite(dipP) else None,
        "bic1": round(gmm["bic1"], 4) if math.isfinite(gmm["bic1"]) else None,
        "bic2": round(gmm["bic2"], 4) if math.isfinite(gmm["bic2"]) else None,
        "dBIC": round(gmm["dBIC"], 4) if math.isfinite(gmm["dBIC"]) else None,
        "ashmanD": round(gmm["ashmanD"], 4) if math.isfinite(gmm["ashmanD"]) else None,
        "weight1": round(gmm["weight1"], 4) if math.isfinite(gmm["weight1"]) else None,
        "weight2": round(gmm["weight2"], 4) if math.isfinite(gmm["weight2"]) else None,
        "mean1": round(gmm["mean1"], 4) if math.isfinite(gmm["mean1"]) else None,
        "mean2": round(gmm["mean2"], 4) if math.isfinite(gmm["mean2"]) else None,
    }
    return rec


def iter_inputs(roots: list[str], pattern_filter: str | None) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        p = Path(root)
        if p.is_file() and p.suffix == ".json":
            files.append(p)
        elif p.is_dir():
            files.extend(sorted(p.rglob("*.json")))
    if pattern_filter:
        files = [f for f in files if pattern_filter in f.name]
    return files


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="+", help="JSON files or directories")
    ap.add_argument(
        "--filter",
        default=None,
        help="Substring filter on filenames (e.g. T3.4).",
    )
    ap.add_argument(
        "--json",
        default=None,
        help="Path to write a JSON array of result records (in addition to TSV stdout).",
    )
    ns = ap.parse_args(argv[1:])

    files = iter_inputs(ns.paths, ns.filter)
    if not files:
        print("[compute-bimodality] no input files found", file=sys.stderr)
        return 2

    cols = [
        "file", "n", "mean", "sd", "skew", "kurt", "BC",
        "dipD", "dipP", "bic1", "bic2", "dBIC", "ashmanD",
        "weight1", "weight2", "mean1", "mean2",
    ]
    print("\t".join(cols))
    records: list[dict[str, Any]] = []
    for f in files:
        rec = analyse_file(f)
        if rec is None:
            continue
        rec["file"] = os.path.relpath(rec["file"])
        records.append(rec)
        print("\t".join(str(rec.get(c, "")) if rec.get(c) is not None else "" for c in cols))

    if ns.json:
        Path(ns.json).write_text(json.dumps(records, indent=2))
        print(f"[compute-bimodality] wrote {len(records)} records to {ns.json}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
