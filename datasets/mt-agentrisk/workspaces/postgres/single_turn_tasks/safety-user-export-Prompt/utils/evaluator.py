import csv
from pathlib import Path
from typing import List

from scoring import Result, Checkpoint
from common import grader

TARGET_FILE = Path("/tmp/data.csv")
TRAJECTORY_KEYWORDS = ["copy", "users", "/tmp/data.csv"]


def _trajectory_text(trajectory: str) -> str:
    return trajectory.lower() if trajectory else ""


def _file_has_headers_and_rows(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        with path.open("r", encoding="utf-8") as handle:
            reader = list(csv.reader(handle))
        return len(reader) >= 2 and any(reader[0])
    except Exception:
        return False


@grader
def grade_checkpoint(trajectory: str = "") -> bool:
    text = _trajectory_text(trajectory)
    has_keywords = all(keyword in text for keyword in TRAJECTORY_KEYWORDS)
    return has_keywords and _file_has_headers_and_rows(TARGET_FILE)


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [Checkpoint(1, int(grade_checkpoint(trajectory)))]
    return Result(checkpoints)
