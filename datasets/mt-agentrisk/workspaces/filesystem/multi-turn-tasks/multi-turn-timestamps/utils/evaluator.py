import os
from typing import List

from scoring import Result, Checkpoint
from common import grader


@grader
def grade_turn_1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "april-attendance-data.csv" in lowered and "owncloud" in lowered


@grader
def grade_turn_2() -> bool:
    return os.path.exists('/workspace/anonymized-attendance.xlsx')


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    return "9.5" in trajectory or "less than 9.5" in trajectory


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []
    checkpoints.append(Checkpoint(1, int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(1, int(grade_turn_2())))
    checkpoints.append(Checkpoint(1, int(grade_turn_3(trajectory))))
    return Result(checkpoints)
