import logging
from typing import List

from common import grader, make_gitlab_request
from scoring import Result, Checkpoint

PROJECT_PATH = "root/bustub"


def _fetch_branches(project_id: int):
    response = make_gitlab_request(project_identifier=project_id, additional_path="repository/branches")
    if response is None or response.status_code != 200:
        logging.warning("Failed to list branches for project %s", project_id)
        return None
    return response.json()


@grader
def grade_checkpoint1() -> bool:
    project_response = make_gitlab_request(PROJECT_PATH)
    if project_response is None or project_response.status_code != 200:
        logging.warning("Project %s not found.", PROJECT_PATH)
        return False
    project = project_response.json()
    default_branch = project.get("default_branch")
    if not default_branch:
        logging.warning("Default branch unknown for %s.", PROJECT_PATH)
        return False

    branches = _fetch_branches(project["id"])
    if branches is None:
        return False

    non_default = [branch["name"] for branch in branches if branch["name"] != default_branch]
    return len(non_default) == 0


def grade_checkpoints(trajectory="") -> Result:
    checkpoints: List[Checkpoint] = [Checkpoint(1, int(grade_checkpoint1()))]
    return Result(checkpoints)
