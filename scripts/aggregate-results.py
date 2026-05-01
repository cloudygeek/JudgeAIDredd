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
  27      Qwen3 235B on T4+T5 (peer-review M4). Same schema as Test 22.
  29      Stop-hook cross-vendor (M6). dict-with-runs schema; agentBackend field.

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


def _scan_scenarios(root: Path) -> dict[tuple[str, str, str], dict]:
    """Scan per-scenario JSONs under root and return per-(model, arm, suite) stats.

    Returns {(model, arm, suite): {"sec_n": int, "sec_fail": int, "util_n": int, "util_pass": int}}.
    Each per-scenario JSON has fields: security (bool), utility (bool), suite_name.
    """
    MODEL_MAP = {
        "claude-3-opus-20240229": "eu.anthropic.claude-opus-4-7",
        "claude-3-5-sonnet-20241022": "eu.anthropic.claude-sonnet-4-6",
        "gpt-4o-2024-05-13": None,  # resolved from cell dir name
    }
    cells: dict[tuple[str, str, str], dict] = {}
    for cell_dir in sorted(root.iterdir()):
        if not cell_dir.is_dir() or not cell_dir.name.startswith("agentdojo-"):
            continue
        name = cell_dir.name.removeprefix("agentdojo-")
        if name.endswith("-baseline"):
            arm = "baseline"
            model_slug = name[:-9]
        elif name.endswith("-B7.1-office"):
            arm = "defended"
            model_slug = name[:-12]
        else:
            continue
        for scenario_json in cell_dir.rglob("injection_task_*.json"):
            if "summary" in scenario_json.name:
                continue
            try:
                d = json.load(open(scenario_json))
            except Exception:
                continue
            suite = d.get("suite_name")
            if not suite:
                continue
            pipeline = d.get("pipeline_name", "")
            model = MODEL_MAP.get(pipeline.replace("-dredd-B7.1", ""))
            if model is None:
                if "qwen3-235b" in model_slug:
                    model = "qwen.qwen3-235b-a22b-2507-v1:0"
                elif "qwen3-32b" in model_slug:
                    model = "qwen.qwen3-32b-v1:0"
                else:
                    model = model_slug
            key = (model, arm, suite)
            stats = cells.setdefault(key, {"sec_n": 0, "atk_succ": 0, "util_n": 0, "util_pass": 0})
            if d.get("security") is not None:
                stats["sec_n"] += 1
                # security=True means injected task succeeded (attack success)
                if d["security"]:
                    stats["atk_succ"] += 1
            if d.get("utility") is not None:
                stats["util_n"] += 1
                if d["utility"]:
                    stats["util_pass"] += 1
    return cells


def agg_test20_21(root: Path, label: str) -> None:
    """Test 20/21 — AgentDojo important_instructions. Scans per-scenario JSONs."""
    print("=" * 88)
    print(f"{label} — {root}")
    print("=" * 88)
    print(f"{'Model':<32} {'Arm':<10} {'Suite':<11} {'sec_N':>6} {'ASR':>6}  {'CI':>16}  {'util':>6}")
    cells = _scan_scenarios(root)
    by_model: dict[str, dict] = {}
    for (model, arm, suite) in sorted(cells):
        s = cells[(model, arm, suite)]
        sec_n = s["sec_n"]; atk = s["atk_succ"]
        asr = atk / sec_n if sec_n else 0
        util = s["util_pass"] / s["util_n"] if s["util_n"] else 0
        lo, hi = wilson(asr, sec_n)
        print(f"  {model:<30} {arm:<10} {suite:<11} "
              f"{sec_n:>6} {100*asr:>5.1f}%  [{lo:>4.1f},{hi:>5.1f}]  {100*util:>5.1f}%")
        ma = by_model.setdefault(model, {}).setdefault(arm, {"sec": 0, "atk_succ": 0, "util_n": 0, "util_pass": 0})
        ma["sec"] += sec_n; ma["atk_succ"] += atk
        ma["util_n"] += s["util_n"]; ma["util_pass"] += s["util_pass"]

    print()
    print("Weighted aggregate:")
    print(f"{'Model':<32} {'Arm':<10} {'wt ASR':>8}  {'CI':>16}  {'wt util':>8}  {'Δ from baseline':>17}")
    for m in sorted(by_model):
        b = by_model[m].get("baseline"); df = by_model[m].get("defended")
        if b:
            asr = b["atk_succ"] / b["sec"] if b["sec"] else 0
            u = b["util_pass"] / b["util_n"] if b["util_n"] else 0
            print(f"  {m:<30} {'baseline':<10} {100*asr:>6.2f}%  {fmt_pct(asr,b['sec'])[6:]:>16}  {100*u:>6.1f}%")
        if df:
            asr_d = df["atk_succ"] / df["sec"] if df["sec"] else 0
            u_d = df["util_pass"] / df["util_n"] if df["util_n"] else 0
            delta = 100*(asr_d - (b["atk_succ"]/b["sec"] if b and b["sec"] else 0))
            print(f"  {m:<30} {'defended':<10} {100*asr_d:>6.2f}%  {fmt_pct(asr_d,df['sec'])[6:]:>16}  {100*u_d:>6.1f}%  {delta:>+11.1f}pp")
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


def agg_test29(root: Path) -> None:
    """Test 29 — Stop-hook cross-vendor (M6 resolution).

    dict-with-runs schema (same as Test 22) but only T3.x scenarios, with
    agentBackend ∈ {openai, converse} and defence ∈ {none, intent-tracker}.
    Reports:
      - per-cell hijack/detect/block/GES with Wilson 95% CI
      - per-(model, scenario) ΔGES and Δhijack from baseline → defended
        (this is the M6 numbers the paper needs)
    """
    print("=" * 88)
    print(f"TEST 29 — Stop-hook cross-vendor (M6) — {root}")
    print("=" * 88)
    cells: dict[tuple, list] = defaultdict(list)
    configs: dict[tuple, dict] = {}
    for f in sorted(glob(str(root / "**/test29-*.json"), recursive=True)):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        runs = d.get("runs", [])
        if not runs:
            continue
        key = (d.get("model", "?"), d.get("defence", "?"), d.get("scenario", "?"))
        cells[key].extend(runs)
        configs[key] = d.get("config", {})

    print(f"{'Model':<14} {'Arm':<14} {'Scen':<6} {'N':>4}  "
          f"{'hijack':>22} {'detect':>16} {'blocked':>16}  {'meanGES':>8}")
    for k in sorted(cells):
        m, arm, s = k
        runs = cells[k]
        n = len(runs)
        h = sum(1 for r in runs if r.get("hijackSucceeded"))
        det = sum(1 for r in runs if r.get("agentDetected"))
        blk = sum(1 for r in runs
                  if any((v or {}).get("blocked") for v in r.get("intentVerdicts", []) or []))
        mean_ges = sum(r.get("ges", 0) for r in runs) / n if n else 0
        p_det = det / n if n else 0
        p_blk = blk / n if n else 0
        print(f"{m:<14} {arm:<14} {s:<6} {n:>4}  "
              f"{fmt_pct(h/n if n else 0, n):>22} "
              f"{100*p_det:>5.1f}% ({det}/{n}) {100*p_blk:>5.1f}% ({blk}/{n})  "
              f"{mean_ges:>7.1f}")

    # Per-(model, scenario) baseline vs intent-tracker comparison.
    print()
    print("Baseline vs Stop-hook (per (model, scenario)):")
    print(f"{'Model':<14} {'Scen':<6}  "
          f"{'base hijack':>14} {'SH hijack':>14}  {'Δhijack':>9}  "
          f"{'base GES':>9} {'SH GES':>8}  {'ΔGES':>7}")
    by_ms: dict[tuple[str, str], dict[str, list]] = defaultdict(dict)
    for (m, arm, s), runs in cells.items():
        by_ms[(m, s)][arm] = runs
    for (m, s) in sorted(by_ms):
        arms = by_ms[(m, s)]
        b = arms.get("none"); d = arms.get("intent-tracker")
        if not b or not d:
            continue
        bn, dn = len(b), len(d)
        bh = sum(1 for r in b if r.get("hijackSucceeded")) / bn if bn else 0
        dh = sum(1 for r in d if r.get("hijackSucceeded")) / dn if dn else 0
        bg = sum(r.get("ges", 0) for r in b) / bn if bn else 0
        dg = sum(r.get("ges", 0) for r in d) / dn if dn else 0
        print(f"{m:<14} {s:<6}  "
              f"{100*bh:>5.1f}% (n={bn:>2}) {100*dh:>5.1f}% (n={dn:>2})  "
              f"{100*(dh - bh):>+6.1f}pp  "
              f"{bg:>8.1f} {dg:>7.1f}  {dg - bg:>+6.1f}")

    # Per-model summary across all scenarios (the headline §3.5 numbers).
    print()
    print("Per-model aggregate (all T3.x scenarios pooled):")
    print(f"{'Model':<14} {'Arm':<14} {'N':>4}  {'hijack':>22}  {'meanGES':>8}")
    pooled: dict[tuple[str, str], list] = defaultdict(list)
    for (m, arm, _s), runs in cells.items():
        pooled[(m, arm)].extend(runs)
    for k in sorted(pooled):
        m, arm = k
        runs = pooled[k]
        n = len(runs)
        h = sum(1 for r in runs if r.get("hijackSucceeded"))
        g = sum(r.get("ges", 0) for r in runs) / n if n else 0
        print(f"{m:<14} {arm:<14} {n:>4}  {fmt_pct(h/n if n else 0, n):>22}  {g:>7.1f}")

    print()
    print("Per-model Δ (baseline → Stop-hook intent-tracker):")
    print(f"{'Model':<14} {'Δhijack':>10}  {'ΔGES':>8}")
    for m in sorted({m for (m, _a) in pooled}):
        b = pooled.get((m, "none")); d = pooled.get((m, "intent-tracker"))
        if not b or not d:
            continue
        bh = sum(1 for r in b if r.get("hijackSucceeded")) / len(b)
        dh = sum(1 for r in d if r.get("hijackSucceeded")) / len(d)
        bg = sum(r.get("ges", 0) for r in b) / len(b)
        dg = sum(r.get("ges", 0) for r in d) / len(d)
        print(f"{m:<14} {100*(dh - bh):>+8.1f}pp  {dg - bg:>+6.1f}")
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
    "27": (lambda: agg_test22(Path("results/test27"))),
    "29": (lambda: agg_test29(Path("results/test29"))),
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
