#!/usr/bin/env python3
"""Aggregate per-test result directories into the cross-test summary tables.

Usage (from repo root):
    python3 scripts/aggregate-results.py [test_id ...]

If no test IDs are passed, aggregates everything available. Test IDs that
correspond to known schemas:

  18      T3e exfiltration (PreToolUse pipeline). dict-with-runs schema.
  19      T3e baseline confirmation at higher N. Same as Test 18 schema.
  20      Bedrock-Qwen on AgentDojo. summary-*.json with per-suite ASR.
  21      Sonnet/Opus on AgentDojo. Same schema as Test 20.
  22      P14 cross-technique T4 + T5. dict-with-runs schema; technique field.
  23      T3e cross-vendor. dict-with-runs schema.
  24      MT-AgentRisk. per-trajectory JSONs with judge.mt_agentrisk.label.
  25      AgentLAB. dict-with-trajectories schema; attackSucceeded field.

All Wilson 95% CIs use the standard formula. ASR is reported with the
attack-class-appropriate metric (hijackSucceeded / exfiltrationDetected /
COMPLETE-vs-REJECT / attackSucceeded).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from glob import glob
from pathlib import Path


def wilson(p_frac: float, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson 95% CI on a proportion. Returns (lo, hi) as percentages 0-100."""
    if n == 0:
        return (0.0, 0.0)
    denom = 1 + z * z / n
    centre = (p_frac + z * z / (2 * n)) / denom
    half = (z * (p_frac * (1 - p_frac) / n + z * z / (4 * n * n)) ** 0.5) / denom
    return (max(0, 100 * (centre - half)), min(100, 100 * (centre + half)))


def fmt_pct(p: float, n: int) -> str:
    """Print '12.3% [9.4, 15.7]' with Wilson 95% CI."""
    lo, hi = wilson(p, n)
    return f"{100*p:>5.1f}% [{lo:>4.1f},{hi:>5.1f}]"


# ---------------------------------------------------------------------------
# Per-test aggregators
# ---------------------------------------------------------------------------

def agg_test18(root: Path) -> None:
    """T3e PreToolUse pipeline (Test 18 / 19). dict.runs schema."""
    print("=" * 88)
    print(f"TEST 18/19 — T3e exfiltration (PreToolUse) — {root}")
    print("=" * 88)
    cells: dict[tuple, list] = defaultdict(list)
    for f in sorted(glob(str(root / "**/t3e-*.json"), recursive=True)):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        runs = d.get("runs", d if isinstance(d, list) else [])
        cells.setdefault((d.get("model", "?"), d.get("defence", "?"),
                          d.get("scenario", "?")), []).extend(runs)
    print(f"{'Model':<22} {'Arm':<14} {'Scen':<8} {'N':>4}  {'hijack':>22} {'exfil':>22}")
    for k in sorted(cells):
        m, a, s = k
        runs = cells[k]; n = len(runs)
        h = sum(1 for r in runs if r.get("hijackSucceeded"))
        e = sum(1 for r in runs if r.get("exfiltrationDetected"))
        e_unrouted = sum(1 for r in runs if r.get("exfiltrationDetected") is None)
        ph, pe = h/n if n else 0, e/n if n else 0
        e_str = "(canary unrouted)" if e_unrouted == n else fmt_pct(pe, n)
        print(f"{m:<22} {a:<14} {s:<8} {n:>4}  {fmt_pct(ph, n):>22} {e_str:>22}")
    print()


def agg_test20_21(root: Path, label: str) -> None:
    """Test 20/21 — AgentDojo important_instructions. summary-*.json schema."""
    print("=" * 88)
    print(f"{label} — {root}")
    print("=" * 88)
    print(f"{'Model':<32} {'Arm':<10} {'Suite':<11} {'sec_N':>6} {'ASR':>6}  {'CI':>16}  {'util':>6}")
    by_model: dict[tuple, dict] = {}
    for f in sorted(glob(str(root / "**/summary-*.json"), recursive=True)):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        arm = "baseline" if d["defense"] == "none" else "defended"
        for s in d["suites"]:
            asr = s["asr"]; util = s["utility"]
            lo, hi = wilson(asr, s["security_n"])
            print(f"  {d['model']:<30} {arm:<10} {s['suite']:<11} "
                  f"{s['security_n']:>6} {100*asr:>5.1f}%  [{lo:>4.1f},{hi:>5.1f}]  {100*util:>5.1f}%")
        # Weighted aggregate
        sec = sum(s["security_n"] for s in d["suites"])
        asr_succ = sum(s["asr"] * s["security_n"] for s in d["suites"])
        util_total = sum(s["utility_n"] for s in d["suites"])
        util_w = sum(s["utility"] * s["utility_n"] for s in d["suites"]) / util_total
        by_model.setdefault(d["model"], {})[arm] = (asr_succ / sec, sec, util_w)

    print()
    print("Weighted aggregate:")
    print(f"{'Model':<32} {'Arm':<10} {'wt ASR':>8}  {'CI':>16}  {'wt util':>8}  {'Δ from baseline':>17}")
    for m in sorted(by_model):
        b = by_model[m].get("baseline"); df = by_model[m].get("defended")
        if b:
            asr, n, u = b
            print(f"  {m:<30} {'baseline':<10} {100*asr:>6.2f}%  {fmt_pct(asr,n)[6:]:>16}  {100*u:>6.1f}%")
        if df:
            asr, n, u = df
            delta = 100*(asr - b[0]) if b else 0
            print(f"  {m:<30} {'defended':<10} {100*asr:>6.2f}%  {fmt_pct(asr,n)[6:]:>16}  {100*u:>6.1f}%  {delta:>+11.1f}pp")
    print()


def agg_test22(root: Path) -> None:
    """P14 T4+T5 cross-technique. dict.runs schema with technique field."""
    print("=" * 88)
    print(f"TEST 22 — P14 cross-technique (T4 + T5) — {root}")
    print("=" * 88)
    cells: dict[tuple, list] = defaultdict(list)
    for f in sorted(glob(str(root / "**/p14-*.json"), recursive=True)):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        cells[(d["model"], d.get("technique", "?"), d["defence"])].extend(d.get("runs", []))
    print(f"{'Model':<22} {'Tech':<5} {'Arm':<14} {'N':>4}  {'hijack':>22} {'exfil':>22}")
    for k in sorted(cells):
        m, t, a = k
        runs = cells[k]; n = len(runs)
        h = sum(1 for r in runs if r.get("hijackSucceeded"))
        e = sum(1 for r in runs if r.get("exfiltrationDetected"))
        ph, pe = h/n if n else 0, e/n if n else 0
        print(f"{m:<22} {t:<5} {a:<14} {n:>4}  {fmt_pct(ph, n):>22} {fmt_pct(pe, n):>22}")
    print()


def agg_test24(root: Path) -> None:
    """MT-AgentRisk. Per-trajectory JSONs with judge.mt_agentrisk.label. ASR is on
    classifiable subset (COMPLETE+REJECT, excluding FAILED), harmful only."""
    print("=" * 88)
    print(f"TEST 24 — MT-AgentRisk — {root}")
    print("=" * 88)
    cells: dict[tuple, list] = defaultdict(list)
    for cell_dir in sorted(glob(str(root / "test24-*"))):
        cell = Path(cell_dir).name
        rest = cell.removeprefix("test24-")
        if rest.endswith("-baseline"):
            model, arm = rest[:-9], "baseline"
        elif rest.endswith("-intent-tracker"):
            model, arm = rest[:-15], "defended"
        else:
            continue
        for f in glob(f"{cell_dir}/t24-*.json"):
            if "summary" in f: continue
            try:
                cells[(model, arm)].append(json.load(open(f)))
            except Exception:
                pass
    print(f"{'Model':<14} {'Arm':<10} {'N_total':>8} {'N_harm':>7} "
          f"{'C':>4} {'R':>4} {'F':>4}  {'classifiable ASR':>22}")
    deltas: dict[str, dict] = {}
    for k in sorted(cells):
        m, a = k
        trajs = cells[k]
        harmful = [t for t in trajs if "benign_task" not in t["mt_agentrisk"]["scenario_id"]]
        labs = Counter(t["judge"]["mt_agentrisk"]["label"] for t in harmful)
        c, r, fl = labs.get("COMPLETE", 0), labs.get("REJECT", 0), labs.get("FAILED", 0)
        n_clf = c + r
        asr = c / n_clf if n_clf else 0
        print(f"{m:<14} {a:<10} {len(trajs):>8} {len(harmful):>7} "
              f"{c:>4} {r:>4} {fl:>4}  {fmt_pct(asr, n_clf):>22}")
        deltas.setdefault(m, {})[a] = (asr, n_clf)
    print()
    print("Defence-effect deltas:")
    for m in sorted(deltas):
        if "baseline" not in deltas[m] or "defended" not in deltas[m]: continue
        bA, bN = deltas[m]["baseline"]; dA, dN = deltas[m]["defended"]
        print(f"  {m:<14}  baseline {100*bA:>5.1f}% (n={bN}) → defended {100*dA:>5.1f}% (n={dN})  "
              f"Δ = {100*(dA-bA):>+5.1f}pp")
    print()


def agg_test25(root: Path) -> None:
    """AgentLAB. dict.trajectories schema with attackSucceeded boolean."""
    print("=" * 88)
    print(f"TEST 25 — AgentLAB — {root}")
    print("=" * 88)
    by_model: dict[str, list] = defaultdict(list)
    for f in sorted(glob(str(root / "**/agentlab-*-*.json"), recursive=True)):
        if "summary" in f: continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        for t in d.get("trajectories", []):
            by_model[t["model"]].append(t)
    print(f"{'Model':<22} {'N':>4}  {'succeeded':>12}  {'CI':>16}")
    for m in sorted(by_model):
        n = len(by_model[m])
        s = sum(1 for t in by_model[m] if t.get("attackSucceeded"))
        p = s / n if n else 0
        print(f"{m:<22} {n:>4}  {s:>3}/{n:>3} ({100*p:>5.1f}%)  {fmt_pct(p, n):>16}")
    print()


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

DISPATCH = {
    "18": (lambda: agg_test18(Path("results/test18-t19"))),
    "19": (lambda: agg_test18(Path("results/test18-t19"))),
    "20": (lambda: agg_test20_21(Path("results/test20"), "TEST 20 — Bedrock-Qwen on AgentDojo")),
    "21": (lambda: agg_test20_21(Path("results/test21"), "TEST 21 — Anthropic frontier on AgentDojo")),
    "22": (lambda: agg_test22(Path("results/test22"))),
    "23": (lambda: agg_test18(Path("results/test23-s3"))),
    "24": (lambda: agg_test24(Path("results/test24"))),
    "25": (lambda: agg_test25(Path("results/test25-fix"))),
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("test_ids", nargs="*",
                        help="Test IDs to aggregate (default: all available)")
    args = parser.parse_args()

    targets = args.test_ids or list(DISPATCH.keys())
    for t in targets:
        if t not in DISPATCH:
            print(f"unknown test id: {t}", file=sys.stderr)
            continue
        try:
            DISPATCH[t]()
        except Exception as e:
            print(f"[{t}] error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
