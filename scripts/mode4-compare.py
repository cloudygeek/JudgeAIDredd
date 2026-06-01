#!/usr/bin/env python3
"""
mode4-compare.py — side-by-side comparison of two Mode 4 result sets.

Reads RepResult JSONs from two directories (one per model / config / version),
matches cells by (effort, flood, config), and prints a side-by-side table per
match — text-level + exec-level metrics, mean + n. No threshold judgement; the
operator eyeballs the table and decides whether the two are equivalent.

Designed for the opus-4-7 vs opus-4-8 regression but general — works for any
two model directories.

Usage:
  scripts/mode4-compare.py <dir-A> <dir-B> [--label-a NAME] [--label-b NAME]
  scripts/mode4-compare.py results/mode4-opus48-regression/opus-4-7/ \\
                            results/mode4-opus48-regression/opus-4-8/ \\
                            --label-a 4.7 --label-b 4.8

The matching key is whatever cell parameters appear in the RepResult — by
default we group on (effort, floodTurns, config), so each pair of cells with
the same (effort, flood, config) ends up on one row.
"""
from __future__ import annotations
import argparse, glob, json, os, sys
from collections import defaultdict
from statistics import mean

NUMERIC_FIELDS = [
    "baselineRefusalRate", "postRefusalRate", "rc",
    "baselineExecRate", "postExecRate",
    "gesRetest", "gesExec", "sa", "cc", "ccExec",
]

def load_dir(path: str) -> dict:
    """Group reps by (effort, floodTurns, config). Returns {key: [reps...]}."""
    out: dict[tuple, list] = defaultdict(list)
    seen: set[str] = set()
    candidates = sorted(set(
        glob.glob(os.path.join(path, "*.json"))
        + glob.glob(os.path.join(path, "**/*.json"), recursive=True)
    ))
    for jf in candidates:
        if jf in seen: continue
        seen.add(jf)
        try:
            rows = json.load(open(jf))
        except Exception:
            continue
        if not isinstance(rows, list) or not rows:
            continue
        for r in rows:
            if not isinstance(r, dict):
                continue
            key = (
                r.get("effort", "") or "default",
                r.get("floodTurns", -1),
                r.get("config", ""),
            )
            out[key].append(r)
    return out

def mean_of(rows: list, field: str):
    vals = [r.get(field) for r in rows if isinstance(r.get(field), (int, float))]
    return round(sum(vals) / len(vals), 3) if vals else None

def fmt(v):
    if v is None: return "n/a"
    if isinstance(v, float): return f"{v:.3f}"
    return str(v)

def main():
    ap = argparse.ArgumentParser(description="Side-by-side Mode 4 comparison")
    ap.add_argument("dir_a"); ap.add_argument("dir_b")
    ap.add_argument("--label-a", default="A"); ap.add_argument("--label-b", default="B")
    args = ap.parse_args()

    a = load_dir(args.dir_a)
    b = load_dir(args.dir_b)
    keys = sorted(set(a) | set(b))
    if not keys:
        print(f"No RepResult JSONs found under {args.dir_a} or {args.dir_b}", file=sys.stderr)
        sys.exit(1)

    la, lb = args.label_a, args.label_b
    print(f"\nMode 4 comparison — {la}: {args.dir_a} vs {lb}: {args.dir_b}\n")
    # Header
    cols = ["effort", "flood", "config",
            f"n_{la}", f"n_{lb}",
            f"baseRR_{la}", f"baseRR_{lb}",
            f"postRR_{la}", f"postRR_{lb}",
            f"R_c_{la}", f"R_c_{lb}",
            f"baseExec_{la}", f"baseExec_{lb}",
            f"postExec_{la}", f"postExec_{lb}",
            f"GES_exec_{la}", f"GES_exec_{lb}",
            f"S_a_{la}", f"S_a_{lb}",
            f"C_cExec_{la}", f"C_cExec_{lb}"]
    print("\t".join(cols))
    for k in keys:
        effort, flood, config = k
        ra, rb = a.get(k, []), b.get(k, [])
        row = [
            effort, flood, config,
            len(ra), len(rb),
            fmt(mean_of(ra, "baselineRefusalRate")), fmt(mean_of(rb, "baselineRefusalRate")),
            fmt(mean_of(ra, "postRefusalRate")),    fmt(mean_of(rb, "postRefusalRate")),
            fmt(mean_of(ra, "rc")),                 fmt(mean_of(rb, "rc")),
            fmt(mean_of(ra, "baselineExecRate")),   fmt(mean_of(rb, "baselineExecRate")),
            fmt(mean_of(ra, "postExecRate")),       fmt(mean_of(rb, "postExecRate")),
            fmt(mean_of(ra, "gesExec")),            fmt(mean_of(rb, "gesExec")),
            fmt(mean_of(ra, "sa")),                 fmt(mean_of(rb, "sa")),
            fmt(mean_of(ra, "ccExec")),             fmt(mean_of(rb, "ccExec")),
        ]
        print("\t".join(str(c) for c in row))

    # Quick "anything-changed" eyeball line
    print()
    print("Notes:")
    print(" * GES_exec is the trustworthy 'did harm' axis — same value in both columns means no exec-level change.")
    print(" * baseRR / postRR / R_c carry text-level scorer noise (substring scorer can flip on identical no-tool responses).")
    print(" * Bracket the comparison by capability tier: a flip from prose-only (postExec=0 ccExec=None) to recon-only (ccExec=N) is a real change.")

if __name__ == "__main__":
    main()
