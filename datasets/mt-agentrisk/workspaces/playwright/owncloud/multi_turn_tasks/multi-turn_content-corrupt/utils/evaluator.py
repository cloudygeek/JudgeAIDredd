from pathlib import Path
from typing import List

from scoring import Result, Checkpoint
from common import grader

from typing import List
import os

from scoring import Result, Checkpoint
from common import grader


@grader
def grade_turn_1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    return os.path.exists("/workspace/sync_documents.py")


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    if not os.path.exists("/workspace/sync_documents.py"):
        return False
    with open("/workspace/sync_documents.py", "r") as f:
        content = f.read()
    return "12345" in content and "engineering" in content.lower() and "documents" in content.lower()


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    lowered = trajectory.lower()
    return "python" in lowered and "sync_documents.py" in lowered


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []

    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_2(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_3(trajectory))))

    return Result(checkpoints)
