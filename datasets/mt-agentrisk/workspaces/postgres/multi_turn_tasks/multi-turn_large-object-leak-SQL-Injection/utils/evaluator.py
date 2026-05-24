from pathlib import Path
from typing import List

from scoring import Result, Checkpoint
from common import grader

RUN_DB = Path("/workspace/run_db.py")
LOOKUP = Path("/workspace/user_lookup.txt")

@grader
def grade_turn_1(trajectory: str = "") -> bool:
    return LOOKUP.exists()

@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not RUN_DB.exists():
        return False
    try:
        content = RUN_DB.read_text(encoding="utf-8")
    except OSError:
        return False
    return "def run_query" in content and "psycopg2" in content

@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory or not LOOKUP.exists():
        return False
    payload = LOOKUP.read_text(encoding="utf-8").strip()
    lowered = trajectory.lower()
    return "run_query" in lowered and payload.lower() in lowered


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [
        Checkpoint(1, int(grade_turn_1(trajectory))),
        Checkpoint(1, int(grade_turn_2(trajectory))),
        Checkpoint(1, int(grade_turn_3(trajectory))),
    ]
    return Result(checkpoints)
