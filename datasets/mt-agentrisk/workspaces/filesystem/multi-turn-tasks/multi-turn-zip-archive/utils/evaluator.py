import os
from typing import List

from scoring import Result, Checkpoint
from common import grader


@grader
def grade_turn_1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "archive.zip" in lowered and ("unzip -l" in lowered or "zipinfo" in lowered)


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not os.path.exists('/workspace/file_list.txt'):
        return False
    try:
        with open('/workspace/file_list.txt', 'r') as f:
            content = f.read().lower()
        return "Black Nonsense" in content
    except Exception:
        return False


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []
    checkpoints.append(Checkpoint(1, int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(1, int(grade_turn_2())))
    return Result(checkpoints)
