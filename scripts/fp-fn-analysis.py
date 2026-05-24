#!/usr/bin/env python3
"""
fp-fn-analysis.py — false-positive / false-negative + precision/recall
estimator for InjecAgent runs (the only benchmark whose summaries
serialise the raw per-cell screen + block counts).

Reviewer 1.5 asked for a robustness discussion that quantifies false
positives, false negatives, and bypass scenarios. The InjecAgent
xvendor summary files (`summary.json`) carry exactly the counts we need:

    succ              — attacks that succeeded against the *defended* cell
    unsucc            — attacks the agent rejected on its own
    screened_clean    — payloads PromptArmor labelled benign
    screened_injected — payloads PromptArmor labelled injected
    dredd_blocked     — calls Dredd hard-blocked
    dredd_allowed     — calls Dredd let through

We pair each defended cell with its `none`-defence sibling (same model,
same attack, same setting) so we can compute lower- and upper-bound
precision/recall without needing per-task ground truth.

Lower-bound assumption (`assume_overlap=true`, default):
    All baseline-successful attacks are *contained* in the defender's
    block set when the defender blocks more than the baseline failure
    rate. In that case:
        TP  = baseline_succ                       (everything blocked
                                                   has at least the
                                                   baseline TP-set in it)
        FP  = blocks - baseline_succ              (extra blocks were
                                                   already-going-to-fail)
        FN  = defended_succ                       (whatever still got
                                                   through is the
                                                   missed set)

Upper-bound assumption (`assume_overlap=false`):
    Treat the defender's block set as independent of baseline outcome:
        TP  = max(0, baseline_succ - defended_succ)
        FP  = blocks - TP
        FN  = defended_succ
    This is the harshest interpretation — useful as an upper bound on FP.

Both assumptions converge when the defender blocks exactly
(baseline_succ - defended_succ) cases. The two columns let the reader
see the bracket.

Output: one row per (model, defence, attack) cell. TSV stdout, optional
--csv.

Usage:
  scripts/fp-fn-analysis.py benchmarks/injecagent/runs/phaseB-injecagent-xvendor-dredd-v422-20260521T143710Z/
  scripts/fp-fn-analysis.py --csv fpfn.csv benchmarks/injecagent/runs/...
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Any


def _summaries(root: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for f in sorted(root.rglob("summary.json")):
        try:
            d = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        d["_file"] = str(f)
        out.append(d)
    return out


def _defence_label(d: dict[str, Any]) -> str:
    parts = []
    if d.get("dredd_defense"):
        parts.append(f"dredd-{d['dredd_defense']}")
    if d.get("promptarmor"):
        parts.append("promptarmor")
    return "+".join(parts) if parts else "none"


def _baseline_index(rows: list[dict[str, Any]]) -> dict[tuple[str, str, str], dict[str, Any]]:
    """Map (model, attack, setting) -> the cell entry from the `none`-defence run."""
    idx: dict[tuple[str, str, str], dict[str, Any]] = {}
    for d in rows:
        if _defence_label(d) != "none":
            continue
        model = d.get("model")
        cells = d.get("cells") or []
        for c in cells:
            key = (model, c.get("attack"), c.get("setting") or "base")
            idx[key] = {**c, "_summary": d}
    return idx


def _row_metrics(
    cell: dict[str, Any],
    baseline: dict[str, Any] | None,
    defence_label: str,
) -> dict[str, Any]:
    total = cell.get("total", 0) or 0
    succ = cell.get("succ", 0) or 0
    unsucc = cell.get("unsucc", 0) or 0
    valid = succ + unsucc
    asr = succ / valid if valid else None
    blocks = (
        (cell.get("screened_injected") or 0)
        + (cell.get("dredd_blocked") or 0)
    )

    if defence_label == "none" or not baseline:
        # Baseline rows: just emit raw counts; precision/recall N/A.
        return {
            "total": total,
            "valid": valid,
            "succ": succ,
            "asr": round(asr, 4) if asr is not None else None,
            "blocks": blocks,
            "screened_clean": cell.get("screened_clean") or 0,
            "screened_injected": cell.get("screened_injected") or 0,
            "dredd_blocked": cell.get("dredd_blocked") or 0,
            "baseline_succ": None,
            "baseline_asr": None,
            "tp_lower": None,
            "fp_lower": None,
            "fn_lower": None,
            "precision_lower": None,
            "recall_lower": None,
            "tp_upper": None,
            "fp_upper": None,
            "fn_upper": None,
            "precision_upper": None,
            "recall_upper": None,
        }

    base_succ = baseline.get("succ", 0) or 0
    base_total = baseline.get("total", 0) or 0
    base_unsucc = baseline.get("unsucc", 0) or 0
    base_valid = base_succ + base_unsucc
    base_asr = base_succ / base_valid if base_valid else None

    # Lower-bound (overlap assumption): defender's blocks are a superset
    # of the baseline's success cases. Anything blocked beyond the
    # baseline-success count is an FP (would-have-failed-anyway).
    tp_low = min(base_succ, blocks)
    fp_low = max(0, blocks - base_succ)
    fn_low = succ
    prec_low = tp_low / (tp_low + fp_low) if (tp_low + fp_low) else None
    rec_low = tp_low / base_succ if base_succ else None

    # Upper-bound (independence assumption): only count the *observed
    # reduction in successful attacks* as TP. Anything beyond that is FP.
    tp_up = max(0, base_succ - succ)
    fp_up = max(0, blocks - tp_up)
    fn_up = succ
    prec_up = tp_up / (tp_up + fp_up) if (tp_up + fp_up) else None
    rec_up = tp_up / base_succ if base_succ else None

    return {
        "total": total,
        "valid": valid,
        "succ": succ,
        "asr": round(asr, 4) if asr is not None else None,
        "blocks": blocks,
        "screened_clean": cell.get("screened_clean") or 0,
        "screened_injected": cell.get("screened_injected") or 0,
        "dredd_blocked": cell.get("dredd_blocked") or 0,
        "baseline_succ": base_succ,
        "baseline_asr": round(base_asr, 4) if base_asr is not None else None,
        "tp_lower": tp_low,
        "fp_lower": fp_low,
        "fn_lower": fn_low,
        "precision_lower": (
            round(prec_low, 4) if prec_low is not None else None
        ),
        "recall_lower": (
            round(rec_low, 4) if rec_low is not None else None
        ),
        "tp_upper": tp_up,
        "fp_upper": fp_up,
        "fn_upper": fn_up,
        "precision_upper": (
            round(prec_up, 4) if prec_up is not None else None
        ),
        "recall_upper": (
            round(rec_up, 4) if rec_up is not None else None
        ),
    }


def collect(roots: list[str]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for r in roots:
        p = Path(r)
        if p.exists():
            summaries.extend(_summaries(p))
    if not summaries:
        return []
    baseline = _baseline_index(summaries)
    rows: list[dict[str, Any]] = []
    for d in summaries:
        defence = _defence_label(d)
        model = d.get("model")
        for c in d.get("cells") or []:
            key = (model, c.get("attack"), c.get("setting") or "base")
            metrics = _row_metrics(c, baseline.get(key), defence)
            rows.append(
                {
                    "model": model,
                    "defence": defence,
                    "attack": c.get("attack"),
                    "setting": c.get("setting") or "base",
                    **metrics,
                    "source": d["_file"],
                }
            )
    return rows


COLS = [
    "model", "defence", "attack", "setting",
    "total", "valid", "succ", "asr", "baseline_succ", "baseline_asr",
    "blocks", "screened_clean", "screened_injected", "dredd_blocked",
    "tp_lower", "fp_lower", "fn_lower", "precision_lower", "recall_lower",
    "tp_upper", "fp_upper", "fn_upper", "precision_upper", "recall_upper",
    "source",
]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="+", help="InjecAgent run dir(s)")
    ap.add_argument("--csv", default=None, help="Write CSV alongside TSV stdout")
    ns = ap.parse_args(argv[1:])

    rows = collect(ns.paths)
    if not rows:
        print("[fp-fn] no rows collected", file=sys.stderr)
        return 2

    print("\t".join(COLS))
    for r in rows:
        r["source"] = os.path.relpath(r["source"])
        print(
            "\t".join(
                str(r.get(c, "")) if r.get(c) is not None else ""
                for c in COLS
            )
        )

    if ns.csv:
        with open(ns.csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=COLS)
            w.writeheader()
            for r in rows:
                w.writerow({c: r.get(c, "") for c in COLS})
        print(f"[fp-fn] wrote {len(rows)} rows to {ns.csv}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
