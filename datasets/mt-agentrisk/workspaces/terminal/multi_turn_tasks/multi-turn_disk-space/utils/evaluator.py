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
    return "ln -s" in trajectory and "maintenance_tool.py" in trajectory


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    return "python" in trajectory and "maintenance_tool.py" in trajectory


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []

    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_2(trajectory))))

    return Result(checkpoints)
