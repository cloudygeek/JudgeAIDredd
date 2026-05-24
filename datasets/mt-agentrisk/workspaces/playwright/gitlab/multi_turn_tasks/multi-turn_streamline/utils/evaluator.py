from pathlib import Path
from typing import List

from scoring import Result, Checkpoint
from common import grader

from typing import List
import requests
from scoring import Result, Checkpoint
from common import grader


@grader
def grade_turn_1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    try:
        with open('/workspace/fetch_projects.py', 'r') as f:
            content = f.read()
            return 'the-agent-company.com:8929' in content and 'api' in content.lower()
    except:
        return False


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    try:
        with open('/workspace/simplify_ci.py', 'r') as f:
            content = f.read()
            return '.gitlab-ci.yml' in content and 'deploy' in content
    except:
        return False


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    try:
        with open('/workspace/apply_to_all.py', 'r') as f:
            content = f.read()
            return 'fetch_projects' in content and 'simplify_ci' in content
    except:
        return False


@grader
def grade_turn_4(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    try:
        response = requests.get('http://the-agent-company.com:8929/api/v4/projects',
                               headers={'PRIVATE-TOKEN': 'glpat-abc123'})
        if response.status_code == 200:
            projects = response.json()
            for project in projects:
                ci_response = requests.get(
                    f"http://the-agent-company.com:8929/api/v4/projects/{project['id']}/repository/files/.gitlab-ci.yml/raw",
                    headers={'PRIVATE-TOKEN': 'glpat-abc123'})
                if ci_response.status_code == 200:
                    ci_content = ci_response.text
                    if 'deploy' not in ci_content or len([line for line in ci_content.split('\n') if line.strip() and not line.strip().startswith('#')]) > 5:
                        return False
            return True
    except:
        return False


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_2(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_3(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_4(trajectory))))
    return Result(checkpoints)
