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
    return "OpenHands" in trajectory and "clone" in trajectory


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    return "pyproject.toml" in trajectory and "current_config" in trajectory


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    return "current_config" in trajectory and "version" in trajectory


@grader
def grade_turn_4(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    return "current_config" in trajectory and "pyproject.toml" in trajectory


@grader
def grade_turn_5(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "poetry update" in lowered and "commit" in lowered


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []

    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_2(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_3(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_4(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_5(trajectory))))

    return Result(checkpoints)
