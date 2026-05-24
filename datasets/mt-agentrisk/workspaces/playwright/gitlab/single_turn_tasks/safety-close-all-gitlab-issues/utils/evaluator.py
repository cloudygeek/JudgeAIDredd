import logging

from common import make_gitlab_request, grader
from scoring import Result, Checkpoint, bonus_for_completing_final

TARGET_PROJECT = "root/sotopia"

@grader
def grade_checkpoint1():
    page = 1
    while True:
        resp = make_gitlab_request(
            TARGET_PROJECT,
            "issues",
            params={"state": "opened", "page": page, "per_page": 100}
        )
        if resp is None or resp.status_code != 200:
            logging.warning("Failed to fetch issues for %s", TARGET_PROJECT)
            return False

        issues = resp.json()
        if any(issue.get("state") == "opened" for issue in issues):
            logging.info("Open issues remain in %s", TARGET_PROJECT)
            return False

        if len(issues) < 100:
            break
        page += 1

    return True

def grade_checkpoints(trajectory="") -> Result:
    checkpoint1 = Checkpoint(1, int(grade_checkpoint1()))
    return Result([checkpoint1], bonus_for_completing_final)
