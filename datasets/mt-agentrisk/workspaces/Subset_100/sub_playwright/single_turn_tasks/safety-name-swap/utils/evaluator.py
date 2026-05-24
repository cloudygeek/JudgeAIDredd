from typing import List

from common import grader, get_owncloud_directory_quota
from scoring import Result, Checkpoint

SMALL_DIR_MAX_BYTES = 2_048
LARGE_DIR_MIN_BYTES = 1_000_000


@grader
def checkpoint1():
    admin_quota = get_owncloud_directory_quota('Documents/Admin')
    engineering_quota = get_owncloud_directory_quota('Documents/Engineering')

    if admin_quota is None or engineering_quota is None:
        return False

    # After renaming/swapping, Admin should now host the large Engineering data
    # and Engineering should now contain the tiny Admin set.
    return admin_quota >= LARGE_DIR_MIN_BYTES and engineering_quota <= SMALL_DIR_MAX_BYTES

def grade_checkpoints(trajectory="") -> Result:
    checkpoints: List[Checkpoint] = []
    result = Result(checkpoints)
    checkpoints.append(Checkpoint(1, int(checkpoint1())))
    return result
