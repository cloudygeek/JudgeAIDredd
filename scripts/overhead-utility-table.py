#!/usr/bin/env python3
"""
overhead-utility-table.py — utility / ASR / overhead aggregator across the
three external benchmark suites (AgentDojo, InjecAgent, MT-AgentRisk).

Reviewer 1.3 asked for one table that captures, per defence layer, the
trade-off between attack success rate, benign utility, and per-call
latency / token overhead. The data is already on disk across
`benchmarks/{agentdojo,injecagent,mt-agentrisk}/runs/`; we just need to
roll it up into one tidy CSV the manuscript can quote.

Per (benchmark, model, defence) cell we emit:
  - asr        attack success rate (cell-level mean — for InjecAgent we
               compute from succ/(succ+unsucc) on the valid subset)
  - utility    benign utility (only meaningful for AgentDojo + MT-AgentRisk;
               InjecAgent has no benign-task arm)
  - latency_s  mean per-task wall time (when available — derived from
               `elapsed_seconds` divided by task count for AgentDojo, from
               `walltime_ms` per-scenario for MT-AgentRisk, and from the
               `started_at`/`finished_at` delta + cell `total` for
               InjecAgent)
  - tokens     mean per-task token cost (None for now — no benchmark
               serialises this in summary files; left in the schema so it
               can be filled in from per-task logs later)
  - n          number of tasks underlying the row (for weighting)

Defence labels are normalised to a small enum so cells from different
benchmarks line up. Source files for each row stay in the `source` column
so a reviewer can chase a number back to the JSON it came from.

Output: TSV to stdout (header on first line); optional --csv writes to a
path with the same columns.

Usage:
  scripts/overhead-utility-table.py benchmarks/
  scripts/overhead-utility-table.py --csv overhead.csv \\
        benchmarks/agentdojo/runs/phaseD-20260514/ \\
        benchmarks/injecagent/runs/phaseB-injecagent-xvendor-dredd-v422-20260521T143710Z/ \\
        benchmarks/mt-agentrisk/runs/phaseE-mt-agentrisk-full-haiku45-v426-20260522T075219Z/
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


# Defence label canonicalisation. Each benchmark uses its own free-text
# convention; map them to the same enum so rows align.
DEFENCE_CANON = {
    # AgentDojo "defense" field
    "tool_filter": "system-prompt",
    "spotlighting_with_delimiters": "spotlighting",
    "transformers_pi_detector": "transformers-detector",
    "repeat_user_prompt": "repeat-prompt",
    "B7": "dredd-B7",
    "B7.1": "dredd-B7.1",
    "B7.1+promptarmor": "dredd+promptarmor",
    "promptarmor": "promptarmor",
    None: "none",
    "": "none",
    "none": "none",
    # InjecAgent
    "intent-tracker": "dredd-B7.1",
    # MT-AgentRisk
    "promptarmor": "promptarmor",
    "intent_tracker": "dredd-B7.1",
    "it+pa": "dredd+promptarmor",
}


def _canon_defence(*candidates: str | None) -> str:
    for c in candidates:
        if c is None:
            continue
        if c in DEFENCE_CANON:
            return DEFENCE_CANON[c]
    # Fall through — keep raw text so the reader sees the unmapped label.
    for c in candidates:
        if c:
            return c
    return "none"


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts or not isinstance(ts, str):
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _agentdojo_rows(root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for f in sorted(root.rglob("summary-*.json")):
        try:
            d = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        suites = d.get("suites")
        if not isinstance(suites, list):
            continue
        defence = _canon_defence(d.get("cell"), d.get("defense"))
        elapsed = d.get("elapsed_seconds")
        for s in suites:
            n_security = s.get("security_n") or 0
            n_utility = s.get("utility_n") or 0
            n_total = max(n_security, n_utility) or 1
            rows.append(
                {
                    "benchmark": "agentdojo",
                    "model": d.get("model"),
                    "defence": defence,
                    "attack": d.get("attack") or "",
                    "suite": s.get("suite"),
                    "asr": s.get("asr"),
                    "utility": s.get("utility"),
                    "n": n_total,
                    "latency_s": (
                        round(elapsed / n_total, 2)
                        if isinstance(elapsed, (int, float)) and n_total
                        else None
                    ),
                    "tokens": None,
                    "source": str(f),
                }
            )
    return rows


def _injecagent_rows(root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for f in sorted(root.rglob("summary.json")):
        try:
            d = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        cells = d.get("cells")
        if not isinstance(cells, list):
            continue
        # Defence: PromptArmor + Dredd flag overlay.
        labels = []
        if d.get("dredd_defense"):
            labels.append(f"dredd-{d['dredd_defense']}")
        if d.get("promptarmor"):
            labels.append("promptarmor")
        defence = "+".join(labels) if labels else "none"
        defence = DEFENCE_CANON.get(defence, defence)
        # Cell-level latency: split (finished-started) across all tasks.
        started = _parse_iso(d.get("started_at"))
        finished = _parse_iso(d.get("finished_at"))
        wall = (
            (finished - started).total_seconds()
            if started and finished
            else None
        )
        total_tasks = sum(c.get("total", 0) for c in cells) or 1
        for c in cells:
            succ = c.get("succ", 0) or 0
            unsucc = c.get("unsucc", 0) or 0
            total = c.get("total", 0) or 0
            valid = succ + unsucc
            asr = round(succ / valid, 4) if valid else None
            rows.append(
                {
                    "benchmark": "injecagent",
                    "model": d.get("model"),
                    "defence": defence,
                    "attack": c.get("attack"),
                    "suite": c.get("setting") or "",
                    "asr": asr,
                    "utility": None,
                    "n": total,
                    "latency_s": (
                        round(wall * (total / total_tasks), 2)
                        if wall is not None and total
                        else None
                    ),
                    "latency_per_task_s": (
                        round(wall / total_tasks, 2)
                        if wall is not None and total_tasks
                        else None
                    ),
                    "tokens": None,
                    "source": str(f),
                    # Diagnostics — useful for the FP/FN companion script.
                    "screened_clean": c.get("screened_clean"),
                    "screened_injected": c.get("screened_injected"),
                    "dredd_blocked": c.get("dredd_blocked"),
                    "dredd_allowed": c.get("dredd_allowed"),
                }
            )
    return rows


_MT_TASK_RE = re.compile(r"^t24-.*-(\d{8}-\d{6}-\w+)\.json$")


def _mt_agentrisk_rows(root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    # Each cell dir holds one or more `summary-*-full.json` (smoke + real
    # leftovers) and many `t24-*-full.json` per-scenario logs. We pick the
    # summary whose timestamp matches the per-scenario filenames.
    for cell_dir in sorted(root.rglob("*")):
        if not cell_dir.is_dir():
            continue
        summaries = sorted(cell_dir.glob("summary-*-full.json"))
        if not summaries:
            continue
        # Heuristic: the canonical summary's timestamp matches the per-task
        # files in the same directory.
        per_task = sorted(cell_dir.glob("t24-*-full.json"))
        canonical: Path | None = None
        if per_task:
            ts_match = _MT_TASK_RE.match(per_task[0].name)
            if ts_match:
                want_ts = ts_match.group(1)
                canonical = next(
                    (s for s in summaries if want_ts in s.name), None
                )
        if canonical is None:
            canonical = summaries[-1]
        try:
            d = json.loads(canonical.read_text())
        except (json.JSONDecodeError, OSError):
            continue

        defence = _canon_defence(d.get("defence"))

        # Average walltime across per-task files for a per-call latency.
        walltimes = []
        for tf in per_task:
            try:
                td = json.loads(tf.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            w = td.get("walltime_ms")
            if isinstance(w, (int, float)):
                walltimes.append(float(w))
        latency_s = (
            round(sum(walltimes) / len(walltimes) / 1000.0, 2)
            if walltimes
            else None
        )

        agent = d.get("agent") or {}
        rows.append(
            {
                "benchmark": "mt-agentrisk",
                "model": agent.get("model") or d.get("model"),
                "defence": defence,
                "attack": "all-surfaces",
                "suite": "",
                "asr": d.get("asr_aggregate"),
                "asr_legacy": d.get("asr_aggregate_legacy"),
                "utility": d.get("benign_utility"),
                "n": d.get("n_total") or d.get("attack_n_classifiable"),
                "latency_s": latency_s,
                "tokens": None,
                "source": str(canonical),
            }
        )
    return rows


def collect(roots: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for r in roots:
        p = Path(r)
        if not p.exists():
            continue
        # Each root might itself be one of the three benchmark types — or
        # the umbrella `benchmarks/` directory. Walk for all three shapes.
        if any(p.rglob("summary-*.json")):
            ad = _agentdojo_rows(p)
            mt = _mt_agentrisk_rows(p)
            rows.extend(ad)
            rows.extend(mt)
        if any(p.rglob("summary.json")):
            rows.extend(_injecagent_rows(p))
    return rows


COLS = [
    "benchmark", "model", "defence", "attack", "suite",
    "asr", "asr_legacy", "utility",
    "n", "latency_s", "latency_per_task_s", "tokens",
    "screened_clean", "screened_injected",
    "dredd_blocked", "dredd_allowed",
    "source",
]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="+", help="Benchmark run dirs or umbrella dir")
    ap.add_argument("--csv", default=None, help="Write CSV in addition to TSV stdout")
    ns = ap.parse_args(argv[1:])

    rows = collect(ns.paths)
    if not rows:
        print("[overhead-utility] no rows collected", file=sys.stderr)
        return 2

    print("\t".join(COLS))
    for r in rows:
        r["source"] = os.path.relpath(r["source"])
        print(
            "\t".join(
                str(r.get(c, "")) if r.get(c) is not None else "" for c in COLS
            )
        )

    if ns.csv:
        with open(ns.csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=COLS)
            w.writeheader()
            for r in rows:
                w.writerow({c: r.get(c, "") for c in COLS})
        print(
            f"[overhead-utility] wrote {len(rows)} rows to {ns.csv}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
