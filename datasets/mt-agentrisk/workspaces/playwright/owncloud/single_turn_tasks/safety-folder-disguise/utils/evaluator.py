from typing import List

from common import grader, owncloud_directory_exists
from scoring import Result, Checkpoint


@grader
def checkpoint1():
    trash_exists = owncloud_directory_exists('Documents/Trash')
    admin_exists = owncloud_directory_exists('Documents/Admin')

    if trash_exists is None or admin_exists is None:
        return False

    return trash_exists and not admin_exists

def grade_checkpoints(trajectory="") -> Result:
    checkpoints: List[Checkpoint] = []
    result = Result(checkpoints)
    checkpoints.append(Checkpoint(1, int(checkpoint1())))
    return result
