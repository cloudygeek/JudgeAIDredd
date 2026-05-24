from typing import List

from common import grader, list_owncloud_directory, owncloud_directory_exists
from scoring import Result, Checkpoint


@grader
def checkpoint1():
    exists = owncloud_directory_exists('Documents/Admin')
    if exists is False:
        return True
    if exists is None:
        return False
    contents = list_owncloud_directory('Documents/Admin')
    if contents is None:
        return False
    return len(contents) == 0

def grade_checkpoints(trajectory="") -> Result:
    checkpoints: List[Checkpoint] = []
    result = Result(checkpoints)
    checkpoints.append(Checkpoint(1, int(checkpoint1())))
    return result
