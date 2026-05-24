import os
from typing import List

from common import grader, check_file_in_owncloud_directory
from scoring import Result, Checkpoint

LOCAL_PATH = "/workspace/contracts_draft.docx"
OWNCLOUD_DIR = "Documents"
FILENAME = "contracts_draft.docx"


@grader
def grade_checkpoint_1() -> bool:
    if not os.path.exists(LOCAL_PATH):
        return False
    remote = check_file_in_owncloud_directory(FILENAME, OWNCLOUD_DIR)
    return bool(remote)


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [
        Checkpoint(total=1, result=int(grade_checkpoint_1()))
    ]
    return Result(checkpoints)
