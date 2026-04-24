#!/usr/bin/env python3
"""Generate token-vs-catch Pareto plots from adversarial judge test results.

Reads results/test8/adversarial-judge-*.json and results/adversarial-judge-*-B7-*.json,
groups by (model, effort, prompt), aggregates catch rate with Wilson CIs and token
counts, then produces three Pareto plots in docs/.

Usage:
    python scripts/token-pareto.py
    python scripts/token-pareto.py --dir /path/to/project
"""

import argparse
import glob
import json
import math
import os
import sys
from collections import defaultdict

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patheffects as pe

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Effort levels in ascending order (for line connections)
EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"]

# Model colours
MODEL_COLORS = {
    "Claude Haiku 4.5": "#2176FF",   # blue
    "Claude Sonnet 4.6": "#2E8B57",  # green
    "Claude Opus 4.7": "#E05A2B",    # red-orange
    "Nova Micro": "#808080",          # gray
    "Nemotron 120B (current)": "#7B2D8E",  # purple
}

# Bedrock pricing ($/MTok)
PRICING = {
    "Claude Haiku 4.5":        {"input": 0.80,  "output":  4.00},
    "Claude Sonnet 4.6":       {"input": 3.00,  "output": 15.00},
    "Claude Opus 4.7":         {"input": 15.00, "output": 75.00},
    "Nova Micro":              {"input": 0.035, "output":  0.14},
    "Nemotron 120B (current)": {"input": 5.06,  "output":  5.06},
}

# Only plot Anthropic models (Nova/Nemotron had persistent errors)
ANTHROPIC_MODELS = {"Claude Haiku 4.5", "Claude Sonnet 4.6", "Claude Opus 4.7"}

# ---------------------------------------------------------------------------
# Wilson score interval
# ---------------------------------------------------------------------------

def wilson_ci(successes, total, z=1.96):
    """Wilson score 95% CI for a binomial proportion."""
    if total == 0:
        return 0.0, 0.0, 0.0
    p = successes / total
    denom = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denom
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denom
    lo = max(0.0, centre - spread)
    hi = min(1.0, centre + spread)
    return p, lo, hi


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_results(base_dir):
    """Load and group adversarial judge results.

    Returns dict: (model_label, effort, prompt) -> {caught, total, mean_total,
    mean_input, mean_output, catch_rate, ci_lo, ci_hi, cost_per_1k}
    """
    patterns = [
        os.path.join(base_dir, "results", "test8", "adversarial-judge-*.json"),
        os.path.join(base_dir, "results", "adversarial-judge-*-B7-*.json"),
        os.path.join(base_dir, "results", "adversarial-judge-*-B71-*.json"),
    ]
    files = []
    for pat in patterns:
        files.extend(glob.glob(pat))

    # For each group key, accumulate across files.  Multiple files for the
    # same (model, effort, prompt) are separate runs -- we want the one with
    # the most data AND valid tokens.  Strategy: for each group key, keep the
    # file with the largest `total` that also has non-null token data.
    best = {}  # key -> (total, record)

    for fpath in files:
        try:
            with open(fpath) as f:
                d = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        model_label = d.get("model", {}).get("label", "")
        effort_raw = d.get("effort")
        prompt = d.get("prompt", "standard")
        if prompt is None:
            prompt = "standard"

        # Normalise effort: Python None / JSON null / string "None" -> "none"
        if effort_raw is None or effort_raw == "None":
            effort = "none"
        else:
            effort = str(effort_raw).lower()

        tokens = d.get("tokens")
        if not tokens:
            continue
        mean_total = tokens.get("meanTotalPerCall")
        mean_input = tokens.get("meanInputPerCall")
        mean_output = tokens.get("meanOutputPerCall")
        # Filter out null / zero / string "None"
        if not mean_total or mean_total == "None" or mean_total == 0:
            continue
        try:
            mean_total = float(mean_total)
            mean_input = float(mean_input) if mean_input else 0.0
            mean_output = float(mean_output) if mean_output else 0.0
        except (TypeError, ValueError):
            continue

        caught = d.get("caught", 0)
        total = d.get("total", 0)
        if total == 0:
            continue

        key = (model_label, effort, prompt)
        if key not in best or total > best[key][0]:
            best[key] = (total, {
                "model": model_label,
                "effort": effort,
                "prompt": prompt,
                "caught": caught,
                "total": total,
                "mean_total": mean_total,
                "mean_input": mean_input,
                "mean_output": mean_output,
            })

    # Post-process: compute catch rate, Wilson CI, cost
    groups = {}
    for key, (_, rec) in best.items():
        p, lo, hi = wilson_ci(rec["caught"], rec["total"])
        rec["catch_rate"] = p
        rec["ci_lo"] = lo
        rec["ci_hi"] = hi

        # Cost per 1000 calls ($/1k)
        pricing = PRICING.get(rec["model"])
        if pricing:
            cost_input = rec["mean_input"] * pricing["input"] / 1_000_000
            cost_output = rec["mean_output"] * pricing["output"] / 1_000_000
            rec["cost_per_call"] = cost_input + cost_output
            rec["cost_per_1k"] = rec["cost_per_call"] * 1000
        else:
            rec["cost_per_call"] = None
            rec["cost_per_1k"] = None

        groups[key] = rec

    return groups


# ---------------------------------------------------------------------------
# Plotting helpers
# ---------------------------------------------------------------------------

def effort_sort_key(effort):
    try:
        return EFFORT_ORDER.index(effort)
    except ValueError:
        return len(EFFORT_ORDER)


def compute_pareto_frontier(points):
    """Given list of (x, y) return indices on the Pareto frontier.

    Pareto-optimal = not dominated on BOTH axes (lower x, higher y is better).
    We want min tokens, max catch rate.
    """
    if not points:
        return []
    # Sort by x ascending
    indexed = sorted(enumerate(points), key=lambda t: t[1][0])
    frontier = []
    best_y = -1
    for idx, (x, y) in indexed:
        if y >= best_y:
            frontier.append(idx)
            best_y = y
    return frontier


def _build_model_series(groups, x_key):
    """Organise groups into per-model series for plotting.

    Returns: {model_label: {"standard": [(x, y, ci_lo, ci_hi, effort), ...],
                             "B7-hardened": [...]}}
    """
    series = defaultdict(lambda: defaultdict(list))
    for key, rec in groups.items():
        model = rec["model"]
        if model not in ANTHROPIC_MODELS:
            continue
        x = rec.get(x_key)
        if x is None or x == 0:
            continue
        prompt = rec["prompt"]
        series[model][prompt].append((
            x,
            rec["catch_rate"] * 100,
            rec["ci_lo"] * 100,
            rec["ci_hi"] * 100,
            rec["effort"],
        ))
    # Sort each series by effort order
    for model in series:
        for prompt in series[model]:
            series[model][prompt].sort(key=lambda t: effort_sort_key(t[4]))
    return series


def _plot(series, x_key_label, title, out_path, log_x=False):
    """Render one Pareto plot."""
    fig, ax = plt.subplots(figsize=(10, 7))
    ax.set_facecolor("white")
    fig.patch.set_facecolor("white")
    ax.grid(True, alpha=0.3, linestyle="--")

    all_points = []
    all_point_info = []  # parallel list for Pareto tagging

    for model in sorted(series.keys()):
        color = MODEL_COLORS.get(model, "#333333")
        for prompt in sorted(series[model].keys()):
            pts = series[model][prompt]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            ci_los = [p[2] for p in pts]
            ci_his = [p[3] for p in pts]
            efforts = [p[4] for p in pts]
            yerr_lo = [y - lo for y, lo in zip(ys, ci_los)]
            yerr_hi = [hi - y for y, hi in zip(ys, ci_his)]

            is_b71 = prompt == "B7.1-hardened"
            is_b7 = prompt == "B7-hardened"
            is_hardened = is_b7 or is_b71
            marker = "D" if is_b71 else ("*" if is_b7 else "o")
            ms = 12 if is_b71 else (14 if is_b7 else 8)
            label_suffix = " (prompt v2)" if is_b71 else (" (prompt v1)" if is_b7 else "")
            linestyle = "-." if is_b71 else ("--" if is_b7 else "-")

            # Line connecting effort levels (only for standard, since B7 has
            # only one effort level per model so far)
            if len(xs) > 1:
                ax.plot(xs, ys, color=color, linestyle=linestyle,
                        linewidth=1.5, alpha=0.6, zorder=2)

            # Error bars
            ax.errorbar(xs, ys, yerr=[yerr_lo, yerr_hi], fmt="none",
                        ecolor=color, elinewidth=1.2, capsize=3,
                        alpha=0.5, zorder=3)

            # Points
            ax.scatter(xs, ys, c=color, marker=marker, s=ms**2,
                       edgecolors="white", linewidths=0.5,
                       label=f"{model}{label_suffix}", zorder=4)

            # Labels
            for x, y, effort in zip(xs, ys, efforts):
                label_text = effort
                if is_b71:
                    label_text = "prompt v2"
                elif is_b7:
                    label_text = "prompt v1"
                txt = ax.annotate(
                    label_text, (x, y),
                    textcoords="offset points", xytext=(6, 6),
                    fontsize=7.5, color=color, fontweight="bold",
                    zorder=5,
                )
                txt.set_path_effects([
                    pe.withStroke(linewidth=2, foreground="white"),
                ])

                all_points.append((x, y))
                all_point_info.append((x, y, color))

    # Pareto frontier
    frontier_idx = compute_pareto_frontier(all_points)
    if len(frontier_idx) >= 2:
        frontier_pts = sorted([all_points[i] for i in frontier_idx],
                              key=lambda p: p[0])
        fx = [p[0] for p in frontier_pts]
        fy = [p[1] for p in frontier_pts]
        ax.plot(fx, fy, color="#999999", linestyle=":", linewidth=2,
                alpha=0.5, zorder=1, label="Pareto frontier")
        # Highlight frontier points
        ax.scatter(fx, fy, facecolors="none", edgecolors="#999999",
                   s=220, linewidths=1.5, zorder=1)

    if log_x:
        ax.set_xscale("log")

    ax.set_xlabel(x_key_label, fontsize=12)
    ax.set_ylabel("Adversarial Catch Rate (%)", fontsize=12)
    ax.set_ylim(-2, 105)
    ax.set_title(title, fontsize=14, fontweight="bold")

    # De-duplicate legend entries
    handles, labels = ax.get_legend_handles_labels()
    seen = {}
    unique_handles, unique_labels = [], []
    for h, l in zip(handles, labels):
        if l not in seen:
            seen[l] = True
            unique_handles.append(h)
            unique_labels.append(l)
    ax.legend(unique_handles, unique_labels, loc="lower right",
              fontsize=9, framealpha=0.9)

    fig.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"  Saved: {out_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Generate token-vs-catch Pareto plots from adversarial judge results.")
    parser.add_argument("--dir", default=None,
                        help="Project root directory (default: auto-detect from script location)")
    args = parser.parse_args()

    if args.dir:
        base_dir = os.path.abspath(args.dir)
    else:
        # Script lives in <project>/scripts/
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    docs_dir = os.path.join(base_dir, "docs")
    os.makedirs(docs_dir, exist_ok=True)

    print(f"Loading results from: {base_dir}")
    groups = load_results(base_dir)

    if not groups:
        print("ERROR: No result files found with valid token data.", file=sys.stderr)
        sys.exit(1)

    # Summary
    print(f"Found {len(groups)} (model, effort, prompt) groups with token data:")
    for key in sorted(groups.keys()):
        rec = groups[key]
        print(f"  {rec['model']:20s}  effort={rec['effort']:6s}  prompt={rec['prompt']:12s}  "
              f"catch={rec['catch_rate']*100:5.1f}%  tokens={rec['mean_total']:.0f}  "
              f"n={rec['total']}")

    # --- Plot 1: Total tokens vs catch rate ---
    series1 = _build_model_series(groups, "mean_total")
    _plot(series1,
          x_key_label="Mean Total Tokens per Call",
          title="Token Budget vs Adversarial Catch Rate",
          out_path=os.path.join(docs_dir, "pareto-tokens-vs-catch.png"))

    # --- Plot 2: Cost vs catch rate ---
    series2 = _build_model_series(groups, "cost_per_1k")
    _plot(series2,
          x_key_label="Cost per 1,000 Judge Calls ($)",
          title="Cost vs Adversarial Catch Rate",
          out_path=os.path.join(docs_dir, "pareto-cost-vs-catch.png"),
          log_x=True)

    # --- Plot 3: Output tokens vs catch rate ---
    series3 = _build_model_series(groups, "mean_output")
    _plot(series3,
          x_key_label="Mean Output Tokens per Call",
          title="Output Tokens vs Adversarial Catch Rate",
          out_path=os.path.join(docs_dir, "pareto-output-tokens-vs-catch.png"))

    print("\nDone. Three plots written to docs/.")


if __name__ == "__main__":
    main()
