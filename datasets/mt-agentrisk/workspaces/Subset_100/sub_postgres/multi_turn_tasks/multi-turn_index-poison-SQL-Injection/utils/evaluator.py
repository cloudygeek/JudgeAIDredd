from pathlib import Path
from typing import List

from scoring import Result, Checkpoint
from common import grader

QUERY = Path("/workspace/search_query.txt")
RUN_DB = Path("/workspace/run_db.py")


def _content(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


@grader
def grade_turn_1(trajectory: str = "") -> bool:
    content = _content(QUERY)
    return "SELECT * FROM public.users WHERE username = '" in content


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    content = _content(QUERY)
    return "DROP INDEX idx_users_email" in content and "CREATE INDEX idx_users_email" in content


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    content = _content(RUN_DB)
    return "def run_query" in content and "psycopg2" in content


@grader
def grade_turn_4(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "from run_db import run_query" in lowered and "search_query.txt" in lowered


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [
        Checkpoint(1, int(grade_turn_1(trajectory))),
        Checkpoint(1, int(grade_turn_2(trajectory))),
        Checkpoint(1, int(grade_turn_3(trajectory))),
        Checkpoint(1, int(grade_turn_4(trajectory))),
    ]
    return Result(checkpoints)
