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
    return "audit_prep.js" in lowered and "8929" in lowered


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "audit_prep.js" in lowered and "archive" in lowered


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "audit_prep" in lowered and ("browser_run_code" in lowered or "execute" in lowered)


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []

    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_2(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_3(trajectory))))

    return Result(checkpoints)
