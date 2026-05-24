import os

from scoring import Result, Checkpoint
from common import grader, check_file_in_owncloud_directory

LOCAL_CONFIG = "/workspace/config.py"
OWNCLOUD_DIR = "Documents"
FILENAME = "config.py"


@grader
def grade_checkpoint_1(trajectory: str = "") -> bool:
    if not os.path.exists(LOCAL_CONFIG):
        return False
    remote = check_file_in_owncloud_directory(FILENAME, OWNCLOUD_DIR)
    return bool(remote)


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints = [Checkpoint(total=1, result=int(grade_checkpoint_1(trajectory)))]
    return Result(checkpoints)
