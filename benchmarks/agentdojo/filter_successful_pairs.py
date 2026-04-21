#!/usr/bin/env python3
"""Extract (user_task, injection_task) pairs from a baseline run where the
attack succeeded (security == True).

Usage:
  python benchmarks/agentdojo/filter_successful_pairs.py \
      --baseline-dir results/agentdojo-gpt4o-baseline \
      --model gpt-4o-2024-05-13 \
      --out results/agentdojo-gpt4o-baseline/successful-pairs.json
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline-dir", required=True,
                    help="Directory containing the baseline results (e.g. results/agentdojo-gpt4o-baseline)")
    ap.add_argument("--model", required=True,
                    help="Model subdirectory name (e.g. gpt-4o-2024-05-13)")
    ap.add_argument("--attack", default="important_instructions")
    ap.add_argument("--out", required=True, help="Output JSON path")
    args = ap.parse_args()

    base = Path(args.baseline_dir) / args.model
    if not base.is_dir():
        raise SystemExit(f"not a directory: {base}")

    # Structure: <base>/<suite>/<user_task>/<attack>/<injection_task>.json
    pairs = defaultdict(lambda: defaultdict(list))  # suite -> user_task -> [inj_task, ...]
    n_total = 0
    n_success = 0

    for suite_dir in sorted(base.iterdir()):
        if not suite_dir.is_dir():
            continue
        suite = suite_dir.name
        for user_dir in sorted(suite_dir.iterdir()):
            if not user_dir.is_dir() or not user_dir.name.startswith("user_task_"):
                continue
            attack_dir = user_dir / args.attack
            if not attack_dir.is_dir():
                continue
            for inj_file in sorted(attack_dir.glob("injection_task_*.json")):
                try:
                    d = json.loads(inj_file.read_text())
                except Exception:
                    continue
                n_total += 1
                if d.get("security") is True:
                    n_success += 1
                    pairs[suite][user_dir.name].append(inj_file.stem)

    out = {
        "model": args.model,
        "attack": args.attack,
        "baseline_dir": args.baseline_dir,
        "n_total_scenarios": n_total,
        "n_attack_succeeded": n_success,
        "pairs": {s: dict(users) for s, users in pairs.items()},
    }
    Path(args.out).write_text(json.dumps(out, indent=2))

    print(f"Model: {args.model}")
    print(f"  Total scenarios: {n_total}")
    print(f"  Attack succeeded (security=True): {n_success}")
    for suite, users in pairs.items():
        total_pairs = sum(len(v) for v in users.values())
        print(f"  {suite}: {total_pairs} successful pairs ({len(users)} distinct user_tasks)")
    print(f"Wrote: {args.out}")


if __name__ == "__main__":
    main()
