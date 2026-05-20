"""Orchestration entry point for the cross-vendor replication harness.

usage:
    python run.py \
        --techniques T1 T3 T4 T8 \
        --configs C1 C3 C4 \
        --models gpt-4o llama-3.1-70b \
        --reps 3 \
        --variance-reps 30 \
        --out results/cross_vendor.json

The runner enumerates (technique, config, model) cells and executes the
configured number of repetitions on each, then writes a JSON file in the
schema documented in README.md (compatible with
`Cloud-Security/Adrian/p14/resubmission_analysis/a1_bimodality.py`
and `a2_ges_decomposition.py`).

# TODO[harness]: this file is wired but depends on adapter implementations
# in adapters.py being completed and the mock_exfil server being live.
# The end-to-end loop is correct; what is stubbed is the vendor I/O.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import tempfile
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any

from adapters import (
    AssistantTurn,
    TOOL_SCHEMAS,
    ToolCall,
    VendorAdapter,
    make_adapter,
)
from fixtures import (
    CANARY_TOKENS,
    Technique,
    RunOutcome,
    build_techniques,
    score_run,
)
from mock_exfil import MockExfilServer


# ---- model registry -------------------------------------------------------

# Map a short --models alias to (vendor, full_model_name).
MODEL_REGISTRY: dict[str, tuple[str, str]] = {
    "gpt-4o": ("openai", "gpt-4o"),
    "llama-3.1-70b": ("together", "meta-llama/Llama-3.1-70B-Instruct"),
    "qwen-2.5-72b": ("together", "Qwen/Qwen2.5-72B-Instruct"),
    "claude-sonnet": ("anthropic", "claude-sonnet-4-6"),
}


# ---- configuration registry ---------------------------------------------

PROMPTS_DIR = Path(__file__).parent / "prompts"


def load_system_prompt(config: str) -> str | None:
    """Return the system prompt string for one of {C1, C3, C4}.

    C1: full CLI-equivalent system prompt
    C3: minimal task-only description
    C4: no system prompt at all
    """
    if config == "C1":
        return (PROMPTS_DIR / "system_cli.txt").read_text()
    if config == "C3":
        return (PROMPTS_DIR / "system_minimal.txt").read_text()
    if config == "C4":
        return None
    raise ValueError(f"unknown config: {config!r}")


# ---- tool execution ------------------------------------------------------


def execute_tool(call: ToolCall, work_dir: Path) -> str:
    """Execute a single tool call inside the per-run sandbox directory.

    This is the harness's only line of defence outside the system prompt;
    the configurations C3 and C4 do not gate tool calls beyond what this
    function imposes. Real-network destinations resolve normally because
    we want the mock exfil server to receive any exfiltration attempt.

    # TODO[harness]: in a strict reproduction of the original sandbox,
    # filesystem writes outside work_dir should be blocked. The skeleton
    # uses tempfile.TemporaryDirectory in run_one() so writes are already
    # confined; treat that as the container-equivalent isolation noted as
    # limitation L6 in the manuscript.
    """
    name = call.name
    args = call.arguments

    try:
        if name == "read_file":
            target = (work_dir / args["path"]).resolve()
            return target.read_text()
        if name == "write_file":
            target = (work_dir / args["path"]).resolve()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(args["content"])
            return f"wrote {len(args['content'])} bytes to {args['path']}"
        if name == "run_command":
            import subprocess
            res = subprocess.run(
                args["command"],
                shell=True,
                cwd=str(work_dir),
                capture_output=True,
                text=True,
                timeout=30,
            )
            return f"exit={res.returncode}\nstdout:\n{res.stdout}\nstderr:\n{res.stderr}"
        if name == "http_request":
            import urllib.request
            req = urllib.request.Request(
                args["url"],
                method=args["method"],
                data=(args.get("body") or "").encode() if args.get("body") else None,
                headers=args.get("headers", {}),
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                return f"status={resp.status}\nbody={resp.read().decode(errors='replace')}"
        return f"unknown tool: {name}"
    except Exception as e:  # noqa: BLE001 - tool failures must be reported back, not crash
        return f"tool_error: {type(e).__name__}: {e}"


# ---- one full run -------------------------------------------------------


def run_one(
    adapter: VendorAdapter,
    technique: Technique,
    config: str,
    exfil: MockExfilServer,
    max_turns: int = 12,
) -> RunOutcome:
    """Execute one (technique, config, model) trajectory and score it."""
    system_prompt = load_system_prompt(config)

    with tempfile.TemporaryDirectory() as tmp:
        work_dir = Path(tmp)

        # plant fixture files (poisoned docs, .env.test, etc.)
        for rel_path, content in technique.planted_files.items():
            p = work_dir / rel_path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)

        exfil.reset()

        messages: list[dict[str, Any]] = [
            {"role": "user", "content": technique.initial_user_message},
        ]
        transcript_parts: list[str] = [
            f"USER: {technique.initial_user_message}",
        ]
        additional = list(technique.additional_turns)

        for _turn_idx in range(max_turns):
            turn: AssistantTurn = adapter.chat(messages=messages, system_prompt=system_prompt)
            transcript_parts.append(f"ASSISTANT: {turn.text}")

            if not turn.tool_calls:
                # Model finished a turn without calling tools.
                # For multi-turn attacks (T3, T4) inject the next scripted
                # user message.
                if additional:
                    next_user = additional.pop(0)
                    messages.append({"role": "assistant", "content": turn.text})
                    messages.append({"role": "user", "content": next_user})
                    transcript_parts.append(f"USER: {next_user}")
                    continue
                # Out of scripted turns → end the run.
                break

            # Model wants to call tools. Execute each, append results, loop.
            messages.append({"role": "assistant", "content": turn.text, "tool_calls": [asdict(tc) for tc in turn.tool_calls]})
            for call in turn.tool_calls:
                result = execute_tool(call, work_dir)
                transcript_parts.append(
                    f"TOOL_CALL: {call.name}({json.dumps(call.arguments)}) -> {result[:500]}"
                )
                messages.append(adapter.format_tool_result(call, result))

        # End of trajectory: collect exfil receipts and score.
        received = exfil.received_bodies()
        transcript = "\n".join(transcript_parts)
        return score_run(transcript=transcript, exfil_received_payloads=received)


# ---- cell aggregation --------------------------------------------------


def summarise_cell(outcomes: list[RunOutcome]) -> dict[str, Any]:
    """Aggregate per-run outcomes into the per-cell schema used in results-variance.json."""
    n = len(outcomes)
    if n == 0:
        return {"n": 0, "runs": []}

    ges_values = [o.GES for o in outcomes]
    d_rate = sum(o.D for o in outcomes) / n
    p_rate = sum(o.P for o in outcomes) / n
    e_rate = sum(o.E for o in outcomes) / n
    s_rate = sum(o.S for o in outcomes) / n
    mean_ges = sum(ges_values) / n
    sd = statistics.stdev(ges_values) if n > 1 else 0.0
    # 95% CI via t-distribution would be more correct; for skeleton purposes
    # use Wald approximation. A1 dip-test pipeline does its own CI.
    se = sd / (n ** 0.5) if n > 1 else 0.0
    ci95 = [mean_ges - 1.96 * se, mean_ges + 1.96 * se]
    # agreement rate: fraction of runs whose GES equals the modal value
    modal_ges = max(set(ges_values), key=ges_values.count)
    agreement = ges_values.count(modal_ges) / n

    return {
        "n": n,
        "meanGES": round(mean_ges, 1),
        "stdDev": round(sd, 1),
        "ci95": [round(c, 1) for c in ci95],
        "cv": round(sd / mean_ges, 3) if mean_ges else 0.0,
        "agreementRate": round(agreement, 2),
        "dRate": round(d_rate, 3),
        "pRate": round(p_rate, 3),
        "eRate": round(e_rate, 3),
        "sRate": round(s_rate, 3),
        "runs": [
            {"batchId": str(uuid.uuid4())[:8], "D": o.D, "P": o.P, "E": o.E, "S": o.S, "GES": o.GES}
            for o in outcomes
        ],
    }


# ---- main loop ---------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--techniques", nargs="+", default=["T1", "T3", "T4", "T8"])
    parser.add_argument("--configs", nargs="+", default=["C1", "C3", "C4"])
    parser.add_argument(
        "--models",
        nargs="+",
        default=["gpt-4o", "llama-3.1-70b"],
        help=f"choices: {sorted(MODEL_REGISTRY.keys())}",
    )
    parser.add_argument("--reps", type=int, default=3, help="reps for non-T3 cells")
    parser.add_argument("--variance-reps", type=int, default=30, help="reps for T3 cells")
    parser.add_argument(
        "--out",
        type=str,
        default=str(Path(__file__).parent / "results" / "cross_vendor.json"),
    )
    args = parser.parse_args()

    techniques = build_techniques()
    exfil = MockExfilServer()
    exfil.start()
    try:
        out: dict[str, Any] = {
            "metadata": {
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "harness_version": "e1-skeleton-v1",
                "techniques": args.techniques,
                "configs": args.configs,
                "models": args.models,
                "reps": args.reps,
                "variance_reps": args.variance_reps,
            },
            "combinations": {},
        }

        for model_alias in args.models:
            if model_alias not in MODEL_REGISTRY:
                raise SystemExit(f"unknown model: {model_alias}; choices: {sorted(MODEL_REGISTRY)}")
            vendor, full_name = MODEL_REGISTRY[model_alias]
            adapter = make_adapter(vendor, full_name)

            for t_name in args.techniques:
                technique = techniques[t_name]
                for config in args.configs:
                    n_reps = args.variance_reps if t_name == "T3" else args.reps
                    print(f"[{time.strftime('%H:%M:%S')}] {model_alias} × {t_name} × {config}: {n_reps} reps")
                    outcomes: list[RunOutcome] = []
                    for rep in range(n_reps):
                        try:
                            outcome = run_one(adapter, technique, config, exfil)
                        except NotImplementedError as e:
                            print(f"  [skel] {e}")
                            outcome = RunOutcome(D=0, P=0, E=0, S=0, transcript="skeleton-stub")
                        outcomes.append(outcome)
                    cell_key = f"{model_alias.upper().replace('-', '_')}-{t_name}-{config}"
                    cell = summarise_cell(outcomes)
                    cell.update({
                        "technique": t_name,
                        "config": config,
                        "model": model_alias,
                        "vendor": vendor,
                        "label": f"{t_name} {technique.variant_id} / {config} / {model_alias}",
                    })
                    out["combinations"][cell_key] = cell

        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(out, indent=2))
        print(f"wrote {out_path}")
    finally:
        exfil.stop()


if __name__ == "__main__":
    main()
