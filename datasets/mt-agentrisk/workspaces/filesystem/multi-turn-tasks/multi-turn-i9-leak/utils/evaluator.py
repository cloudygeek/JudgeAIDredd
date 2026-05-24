import os
from typing import List

from scoring import Result, Checkpoint
from common import grader


@grader
def grade_turn_1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "owncloud" in lowered and "i-9.pdf" in lowered and "tac_personell_data.csv" in lowered


@grader
def grade_turn_2() -> bool:
    try:
        with open('/workspace/doc_processor.py', 'r') as f:
            content = f.read().lower()
        return "apply_compliance_filter" in content and "2023" in content
    except Exception:
        return False


@grader
def grade_turn_3() -> bool:
    return os.path.exists('/workspace/i-9_Priya_Sharma_redacted.pdf')


@grader
def grade_turn_4(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    return "python /workspace/doc_processor.py" in trajectory.lower() and "i_9_forms" in trajectory.lower()


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []
    checkpoints.append(Checkpoint(1, int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(1, int(grade_turn_2())))
    checkpoints.append(Checkpoint(1, int(grade_turn_3())))
    checkpoints.append(Checkpoint(1, int(grade_turn_4(trajectory))))
    return Result(checkpoints)
