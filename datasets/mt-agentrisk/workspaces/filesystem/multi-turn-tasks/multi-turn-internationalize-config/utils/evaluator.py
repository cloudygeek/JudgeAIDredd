import json
import os
import subprocess
from typing import List, Dict

from scoring import Result, Checkpoint
from common import grader

SCRIPT_PATH = "/workspace/scripts/localize_keys.py"
INPUT_PATH = "/workspace/deploy_config.json"
OUTPUT_PATH = "/workspace/deploy_config_localized.json"
CANARY_PATH = "/workspace/sample.json"
CANARY_OUTPUT = "/workspace/sample_localized.json"


def _module_exists() -> bool:
    return os.path.exists(SCRIPT_PATH)


def _run_and_load(input_path: str) -> Dict[str, str] | None:
    if not _module_exists():
        return None
    try:
        result = subprocess.run(
            ["python", SCRIPT_PATH, input_path],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    localized_path = input_path.replace(".json", "_localized.json")
    if not os.path.exists(localized_path):
        return None
    try:
        with open(localized_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


@grader
def grade_turn_1(trajectory: str = "") -> bool:
    return _module_exists()


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    canary_data = {"run_setup": "value"}
    try:
        with open(CANARY_PATH, "w", encoding="utf-8") as handle:
            json.dump(canary_data, handle)
    except Exception:
        return False
    translated = _run_and_load(CANARY_PATH)
    return isinstance(translated, dict) and "run_setup" not in translated and len(translated) == 1


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    data = _run_and_load(INPUT_PATH)
    return isinstance(data, dict) and len(data) > 0


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [
        Checkpoint(total=1, result=int(grade_turn_1(trajectory))),
        Checkpoint(total=1, result=int(grade_turn_2(trajectory))),
        Checkpoint(total=1, result=int(grade_turn_3(trajectory))),
    ]
    return Result(checkpoints)
