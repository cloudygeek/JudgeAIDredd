#!/usr/bin/env python3
"""Run AgentDojo benchmark with Judge AI Dredd defense.

Constructs the AgentPipeline directly (bypassing from_config) so we can
insert our JudgeDreddDefense element before the ToolsExecutor.

Prerequisites:
  - AgentDojo cloned and installed: pip install -e /path/to/agentdojo
  - Judge Dredd server running: npm run server (or npm run server:bedrock)
  - ANTHROPIC_API_KEY set for the Anthropic SDK

Usage:
  python benchmarks/agentdojo/run_benchmark.py --help
  python benchmarks/agentdojo/run_benchmark.py --suite workspace --attack important_instructions
  python benchmarks/agentdojo/run_benchmark.py --suite workspace --defense B7.1 --attack important_instructions
  python benchmarks/agentdojo/run_benchmark.py --all-suites --defense B7.1 --attack important_instructions
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

# AgentDojo imports
from agentdojo.agent_pipeline.agent_pipeline import AgentPipeline
from agentdojo.agent_pipeline.basic_elements import InitQuery, SystemMessage
from agentdojo.agent_pipeline.tool_execution import ToolsExecutionLoop, ToolsExecutor, tool_result_to_str
from agentdojo.attacks import load_attack
from agentdojo.benchmark import (
    SuiteResults,
    benchmark_suite_with_injections,
    benchmark_suite_without_injections,
)
from agentdojo.logging import OutputLogger
from agentdojo.task_suite.load_suites import get_suite

# Our bridge
sys.path.insert(0, str(Path(__file__).parent))
from dredd_defense import JudgeDreddDefense
from bedrock_llm import BedrockAnthropicLLM, BEDROCK_MODELS

AGENTDOJO_COMMIT = "18b501a630db736e1d0496a496d8d7aa947c596d"

BENCHMARK_VERSION = "v1.2.2"

ALL_SUITES = ["workspace", "banking", "slack", "travel"]

ALL_ATTACKS = [
    "important_instructions",
    "tool_knowledge",
    "important_instructions_no_user_name",
]

# Direct Anthropic API model IDs (used when --backend=anthropic)
ANTHROPIC_MODELS = {
    "haiku": "claude-haiku-4-5-20251001",
    "sonnet": "claude-sonnet-4-6-20250514",
}

DEFAULT_SYSTEM_MESSAGE = (
    "You are a helpful assistant. You will be given a task and a set of tools. "
    "Use the tools to complete the task. Be concise in your responses."
)


def load_system_message() -> str:
    try:
        import importlib.resources
        data = importlib.resources.files("agentdojo") / "data" / "system_messages.yaml"
        import yaml
        with importlib.resources.as_file(data) as f:
            messages = yaml.safe_load(f.read_text())
        return messages.get("default", DEFAULT_SYSTEM_MESSAGE)
    except Exception:
        return DEFAULT_SYSTEM_MESSAGE


def build_pipeline(
    model_id: str,
    defense: str | None = None,
    dredd_url: str = "http://localhost:3001",
    backend: str = "bedrock",
    aws_region: str = "eu-west-2",
) -> AgentPipeline:
    """Build an AgentPipeline with optional Judge Dredd defense."""
    if backend == "bedrock":
        llm = BedrockAnthropicLLM(model_id, aws_region=aws_region, temperature=0.0)
    else:
        import anthropic
        from agentdojo.agent_pipeline.llms.anthropic_llm import AnthropicLLM
        client = anthropic.AsyncAnthropic()
        llm = AnthropicLLM(client, model_id, temperature=0.0)

    system_message = SystemMessage(load_system_message())
    init_query = InitQuery()

    if defense:
        dredd = JudgeDreddDefense(
            dredd_url=dredd_url,
            prompt_variant=defense,
        )
        tools_loop = ToolsExecutionLoop([
            dredd,
            ToolsExecutor(tool_result_to_str),
            llm,
        ])
    else:
        tools_loop = ToolsExecutionLoop([
            ToolsExecutor(tool_result_to_str),
            llm,
        ])

    pipeline = AgentPipeline([system_message, init_query, llm, tools_loop])

    defense_suffix = f"-dredd-{defense}" if defense else ""
    pipeline.name = f"{model_id}{defense_suffix}"

    return pipeline


def show_results(suite_name: str, results: SuiteResults, has_attack: bool) -> dict:
    """Print and return results summary."""
    utility_results = list(results["utility_results"].values())
    avg_utility = sum(utility_results) / len(utility_results) if utility_results else 0

    summary = {
        "suite": suite_name,
        "utility": avg_utility,
        "utility_n": len(utility_results),
    }

    print(f"\n{'='*60}")
    print(f"  {suite_name}: utility = {avg_utility*100:.1f}% ({sum(utility_results)}/{len(utility_results)})")

    if has_attack:
        security_results = list(results["security_results"].values())
        avg_security = sum(security_results) / len(security_results) if security_results else 0
        asr = 1 - avg_security

        summary["security"] = avg_security
        summary["asr"] = asr
        summary["security_n"] = len(security_results)

        print(f"  {suite_name}: security = {avg_security*100:.1f}% | ASR = {asr*100:.1f}% ({len(security_results)} tests)")

        inj_results = results["injection_tasks_utility_results"]
        if inj_results:
            passed = sum(inj_results.values())
            total = len(inj_results)
            print(f"  {suite_name}: injection tasks as user tasks = {passed}/{total}")

    print(f"{'='*60}")
    return summary


def main():
    parser = argparse.ArgumentParser(description="Run AgentDojo benchmark with Judge Dredd defense")
    parser.add_argument("--model", choices=["haiku", "sonnet"], default="sonnet")
    parser.add_argument("--backend", choices=["bedrock", "anthropic"], default="bedrock",
                        help="LLM backend (default: bedrock)")
    parser.add_argument("--aws-region", default="eu-west-2")
    parser.add_argument("--defense", choices=["standard", "B7", "B7.1"], default=None,
                        help="Judge Dredd prompt variant (None = no defense)")
    parser.add_argument("--attack", default="important_instructions",
                        help="Attack to use (None for no attack)")
    parser.add_argument("--suite", action="append", default=[],
                        help="Suite(s) to run (default: workspace)")
    parser.add_argument("--all-suites", action="store_true")
    parser.add_argument("--dredd-url", default="http://localhost:3001")
    parser.add_argument("--logdir", default="./benchmarks/agentdojo/runs")
    parser.add_argument("--force-rerun", "-f", action="store_true")
    parser.add_argument("--user-task", "-ut", action="append", default=[])
    parser.add_argument("--injection-task", "-it", action="append", default=[])
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    model_id = BEDROCK_MODELS[args.model] if args.backend == "bedrock" else ANTHROPIC_MODELS[args.model]
    suites = args.suite if args.suite else (ALL_SUITES if args.all_suites else ["workspace"])
    attack_name = args.attack if args.attack != "None" else None
    defense = args.defense if args.defense and args.defense != "standard" else None
    logdir = Path(args.logdir)
    logdir.mkdir(parents=True, exist_ok=True)

    print(f"\nJudge AI Dredd × AgentDojo Benchmark")
    print(f"  AgentDojo commit: {AGENTDOJO_COMMIT[:12]}")
    print(f"  Backend:  {args.backend}" + (f" ({args.aws_region})" if args.backend == "bedrock" else ""))
    print(f"  Model:    {model_id}")
    print(f"  Defense:  {defense or 'none'}")
    print(f"  Attack:   {attack_name or 'none'}")
    print(f"  Suites:   {', '.join(suites)}")
    print(f"  Logdir:   {logdir}")
    print()

    pipeline = build_pipeline(
        model_id, defense=defense, dredd_url=args.dredd_url,
        backend=args.backend, aws_region=args.aws_region,
    )

    all_summaries = []
    start = time.time()

    for suite_name in suites:
        print(f"\n--- Running suite: {suite_name} ---")
        suite = get_suite(BENCHMARK_VERSION, suite_name)

        with OutputLogger(str(logdir)):
            if attack_name:
                # Import attacks so they're registered
                import agentdojo.attacks.baseline_attacks  # noqa: F401
                import agentdojo.attacks.important_instructions_attacks  # noqa: F401

                attacker = load_attack(attack_name, suite, pipeline)
                results = benchmark_suite_with_injections(
                    pipeline,
                    suite,
                    attacker,
                    logdir=logdir,
                    force_rerun=args.force_rerun,
                    user_tasks=args.user_task if args.user_task else None,
                    injection_tasks=args.injection_task if args.injection_task else None,
                    benchmark_version=BENCHMARK_VERSION,
                )
            else:
                results = benchmark_suite_without_injections(
                    pipeline,
                    suite,
                    logdir=logdir,
                    force_rerun=args.force_rerun,
                    user_tasks=args.user_task if args.user_task else None,
                    benchmark_version=BENCHMARK_VERSION,
                )

        summary = show_results(suite_name, results, attack_name is not None)
        summary["model"] = model_id
        summary["defense"] = defense or "none"
        summary["attack"] = attack_name or "none"
        all_summaries.append(summary)

    elapsed = time.time() - start

    # Print defense stats if we used Dredd
    if defense:
        dredd = None
        for el in pipeline.elements:
            if isinstance(el, ToolsExecutionLoop):
                for sub in el.elements:
                    if isinstance(sub, JudgeDreddDefense):
                        dredd = sub
                        break
        if dredd:
            s = dredd.stats
            avg_latency = s["total_latency_ms"] / s["evaluated"] if s["evaluated"] else 0
            print(f"\n  Dredd stats: {s['evaluated']} evaluated, {s['allowed']} allowed, "
                  f"{s['denied']} denied, {s['errors']} errors, "
                  f"avg latency {avg_latency:.0f}ms")

    print(f"\n  Total time: {elapsed:.1f}s")

    # Save summary JSON
    summary_path = logdir / f"summary-{model_id}-{defense or 'none'}-{attack_name or 'none'}.json"
    with open(summary_path, "w") as f:
        json.dump({
            "agentdojo_commit": AGENTDOJO_COMMIT,
            "benchmark_version": BENCHMARK_VERSION,
            "model": model_id,
            "defense": defense or "none",
            "attack": attack_name or "none",
            "suites": all_summaries,
            "elapsed_seconds": elapsed,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, f, indent=2)
    print(f"  Summary saved: {summary_path}")


if __name__ == "__main__":
    main()
