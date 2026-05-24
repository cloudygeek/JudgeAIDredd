from pathlib import Path
from typing import List

from scoring import Result, Checkpoint
from common import grader

from typing import List

from scoring import Result, Checkpoint
from common import grader


@grader
def grade_turn_1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "grace nguyen" in lowered and "completed" in lowered


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    return "sendcustomernotification" in trajectory.lower() and "window." in trajectory.lower()


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "sendcustomernotification()" in lowered and "click()" in lowered


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []

    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_2(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_3(trajectory))))

    return Result(checkpoints)
