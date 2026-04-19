#!/usr/bin/env python3
"""
Compute Wilson 95% confidence intervals for adversarial judge results (Test 8).

Reads all results/test8/adversarial-judge-*.json files, groups by (model, effort),
aggregates caught/total across files, and outputs markdown tables.

No external dependencies beyond Python stdlib.
"""

import argparse
import glob
import json
import math
import os
import sys
from collections import defaultdict
from typing import Optional


def wilson_ci(k: int, n: int, z: float = 1.96) -> dict:
    """
    Compute Wilson score confidence interval.

    Parameters
    ----------
    k : int
        Number of successes (caught).
    n : int
        Number of trials (total).
    z : float
        Z-score for desired confidence level (default 1.96 for 95%).

    Returns
    -------
    dict with keys 'lo', 'hi', 'centre', 'rate'.
    """
    if n == 0:
        return {"lo": 0.0, "hi": 0.0, "centre": 0.0, "rate": 0.0}

    p = k / n
    z2 = z * z
    denom = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / denom
    margin = (z / denom) * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
    lo = max(0.0, centre - margin)
    hi = min(1.0, centre + margin)

    return {"lo": lo, "hi": hi, "centre": centre, "rate": p}


# Effort display order
EFFORT_ORDER = {"none": 0, "low": 1, "medium": 2, "high": 3, "max": 4}


def effort_label(effort_val) -> str:
    """Normalise effort value for display."""
    if effort_val is None:
        return "none"
    return str(effort_val).lower()


def effort_sort_key(label: str) -> int:
    return EFFORT_ORDER.get(label, 99)


def load_files(results_dir: str) -> list:
    """Load all adversarial-judge-*.json files from the given directory."""
    pattern = os.path.join(results_dir, "adversarial-judge-*.json")
    paths = sorted(glob.glob(pattern))
    records = []
    for path in paths:
        try:
            with open(path, "r") as f:
                data = json.load(f)
            records.append(data)
        except (json.JSONDecodeError, OSError) as e:
            print(f"WARNING: skipping {path}: {e}", file=sys.stderr)
    return records


def aggregate(records: list, model_filter: Optional[str], effort_filter: Optional[str]):
    """
    Group records by (model_label, effort) and aggregate.

    Returns
    -------
    agg : dict[(model_label, effort_label)] -> {"caught": int, "total": int, "files": int}
    case_agg : dict[(model_label, effort_label, caseId)] -> {
        "caught": int, "total": int, "pretextType": str
    }
    """
    agg = defaultdict(lambda: {"caught": 0, "total": 0, "files": 0})
    case_agg = defaultdict(lambda: {"caught": 0, "total": 0, "pretextType": ""})

    for rec in records:
        model_label = rec.get("model", {}).get("label", "unknown")
        effort = effort_label(rec.get("effort"))

        # Apply filters
        if model_filter and model_filter.lower() not in model_label.lower():
            continue
        if effort_filter and effort != effort_filter.lower():
            continue

        key = (model_label, effort)

        # Aggregate top-level caught/total
        rec_caught = rec.get("caught", 0)
        rec_total = rec.get("total", 0)
        agg[key]["caught"] += rec_caught
        agg[key]["total"] += rec_total
        agg[key]["files"] += 1

        # Per-case aggregation
        for case in rec.get("cases", []):
            case_id = case.get("caseId", "?")
            pretext = case.get("pretextType", "")
            case_key = (model_label, effort, case_id)
            case_agg[case_key]["pretextType"] = pretext

            if "reps" in case and isinstance(case["reps"], list):
                # Repeated experiment: count caught reps
                for rep in case["reps"]:
                    case_agg[case_key]["total"] += 1
                    if rep.get("caught", False):
                        case_agg[case_key]["caught"] += 1
            else:
                # Single-shot experiment: one trial
                case_agg[case_key]["total"] += 1
                if case.get("caught", False):
                    case_agg[case_key]["caught"] += 1

    return dict(agg), dict(case_agg)


def format_pct(val: float) -> str:
    """Format a proportion as a percentage string."""
    return f"{val * 100:.1f}%"


def print_aggregate_table(agg: dict):
    """Print the aggregate markdown table."""
    # Sort by model label then effort order
    rows = []
    for (model, effort), data in agg.items():
        ci = wilson_ci(data["caught"], data["total"])
        rows.append({
            "model": model,
            "effort": effort,
            "caught": data["caught"],
            "total": data["total"],
            "files": data["files"],
            "rate": ci["rate"],
            "lo": ci["lo"],
            "hi": ci["hi"],
        })

    rows.sort(key=lambda r: (r["model"], effort_sort_key(r["effort"])))

    # Print table
    print("## Aggregate Catch Rates by Model and Effort")
    print()
    print("| Model | Effort | Files | Caught/Total | Rate | 95% Wilson CI |")
    print("|-------|--------|------:|-------------:|-----:|--------------:|")
    for r in rows:
        ci_str = f"[{format_pct(r['lo'])}, {format_pct(r['hi'])}]"
        print(
            f"| {r['model']} "
            f"| {r['effort']} "
            f"| {r['files']} "
            f"| {r['caught']}/{r['total']} "
            f"| {format_pct(r['rate'])} "
            f"| {ci_str} |"
        )
    print()


def print_per_case_tables(case_agg: dict):
    """Print per-case markdown tables, one per (model, effort) group."""
    # Group case entries by (model, effort)
    groups = defaultdict(list)
    for (model, effort, case_id), data in case_agg.items():
        ci = wilson_ci(data["caught"], data["total"])
        groups[(model, effort)].append({
            "caseId": case_id,
            "pretextType": data["pretextType"],
            "caught": data["caught"],
            "total": data["total"],
            "rate": ci["rate"],
            "lo": ci["lo"],
            "hi": ci["hi"],
        })

    # Sort groups by model then effort
    sorted_keys = sorted(groups.keys(), key=lambda k: (k[0], effort_sort_key(k[1])))

    print("## Per-Case Catch Rates")
    print()

    for model, effort in sorted_keys:
        cases = groups[(model, effort)]
        # Sort by caseId numerically (adv-1, adv-2, ...)
        cases.sort(key=lambda c: (
            int(c["caseId"].split("-")[-1]) if c["caseId"].split("-")[-1].isdigit() else c["caseId"]
        ))

        print(f"### {model} (effort={effort})")
        print()
        print("| CaseID | PretextType | Caught/Total | Rate | 95% Wilson CI |")
        print("|--------|-------------|-------------:|-----:|--------------:|")
        for c in cases:
            ci_str = f"[{format_pct(c['lo'])}, {format_pct(c['hi'])}]"
            print(
                f"| {c['caseId']} "
                f"| {c['pretextType']} "
                f"| {c['caught']}/{c['total']} "
                f"| {format_pct(c['rate'])} "
                f"| {ci_str} |"
            )
        print()


def main():
    parser = argparse.ArgumentParser(
        description="Compute Wilson 95% CI for adversarial judge results (Test 8)"
    )
    parser.add_argument(
        "--dir",
        default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "results", "test8"),
        help="Directory containing adversarial-judge-*.json files "
             "(default: results/test8 relative to project root)"
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Filter to models whose label contains this string (case-insensitive)"
    )
    parser.add_argument(
        "--effort",
        default=None,
        choices=["none", "low", "medium", "high", "max"],
        help="Filter to a specific effort level"
    )
    parser.add_argument(
        "--aggregate-only",
        action="store_true",
        help="Only print the aggregate table, skip per-case breakdown"
    )
    parser.add_argument(
        "--per-case-only",
        action="store_true",
        help="Only print the per-case tables, skip aggregate"
    )

    args = parser.parse_args()

    records = load_files(args.dir)
    if not records:
        print(f"No adversarial-judge-*.json files found in {args.dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(records)} result files from {args.dir}", file=sys.stderr)

    agg, case_agg = aggregate(records, args.model, args.effort)

    if not agg:
        print("No matching records after filtering.", file=sys.stderr)
        sys.exit(1)

    if not args.per_case_only:
        print_aggregate_table(agg)

    if not args.aggregate_only:
        print_per_case_tables(case_agg)


if __name__ == "__main__":
    main()
