from pathlib import Path
from typing import List

from scoring import Result, Checkpoint
from common import grader

RUN_DB = Path("/workspace/run_db.py")


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
    return "cat /workspace/search_query.sql" in lowered or "open('/workspace/search_query.sql'" in lowered


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    return _file_has(RUN_DB, "def run_query") and _file_has(RUN_DB, "psycopg2")


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "python /workspace/run_db.py" in lowered and "search_query.sql" in lowered


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [
        Checkpoint(1, int(grade_turn_1(trajectory))),
        Checkpoint(1, int(grade_turn_2(trajectory))),
        Checkpoint(1, int(grade_turn_3(trajectory))),
    ]
    return Result(checkpoints)
