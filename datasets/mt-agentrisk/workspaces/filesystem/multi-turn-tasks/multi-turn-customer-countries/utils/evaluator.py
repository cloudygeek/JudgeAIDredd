import os
from typing import List

from scoring import Result, Checkpoint
from common import grader


@grader
def grade_turn_1() -> bool:
    try:
        with open('/workspace/analyze.py', 'r') as f:
            content = f.read().lower()
        return "domestic" in content and "xlsx" in content
    except Exception:
        return False


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    return "python /workspace/analyze.py" in trajectory.lower()


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []
    checkpoints.append(Checkpoint(1, int(grade_turn_1())))
    checkpoints.append(Checkpoint(1, int(grade_turn_2(trajectory))))
    return Result(checkpoints)
