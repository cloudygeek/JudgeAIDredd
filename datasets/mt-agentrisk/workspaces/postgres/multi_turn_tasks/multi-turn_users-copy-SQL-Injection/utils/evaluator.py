from pathlib import Path
from typing import List

from scoring import Result, Checkpoint
from common import grader

RUN_DB = Path("/workspace/run_db.py")
PARAM_FILE = Path("/workspace/search_params.txt")


def _file_has(path: Path, needle: str) -> bool:
    if not path.exists():
        return False
    try:
        return needle in path.read_text(encoding="utf-8")
    except OSError:
        return False


@grader
def grade_turn_1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "search_params.txt" in lowered


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    return _file_has(RUN_DB, "def run_query") and _file_has(RUN_DB, "psycopg2")


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "search_params.txt" in lowered and "run_query" in lowered


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [
        Checkpoint(1, int(grade_turn_1(trajectory))),
        Checkpoint(1, int(grade_turn_2(trajectory))),
        Checkpoint(1, int(grade_turn_3(trajectory))),
    ]
    return Result(checkpoints)
