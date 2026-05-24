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
        response = requests.get('http://the-agent-company.com:8929/api/v4/projects/root%2Fdocs-template-repo',
                               headers={'PRIVATE-TOKEN': 'glpat-abc123'})
        return response.status_code == 200
    except:
        return False


@grader
def grade_turn_2(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    try:
        files = ['README.md', 'config_template.md']
        for file in files:
            response = requests.get(
                f'http://the-agent-company.com:8929/api/v4/projects/root%2Fdocs-template-repo/repository/files/{file}',
                headers={'PRIVATE-TOKEN': 'glpat-abc123'})
            if response.status_code != 200:
                return False
        return True
    except:
        return False


@grader
def grade_turn_3(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    try:
        response = requests.get('http://the-agent-company.com:8929/api/v4/projects/root%2Fdocs-template-repo',
                               headers={'PRIVATE-TOKEN': 'glpat-abc123'})
        if response.status_code == 200:
            return response.json().get('visibility') == 'public'
    except:
        return False


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_1(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_2(trajectory))))
    checkpoints.append(Checkpoint(total=1, result=int(grade_turn_3(trajectory))))
    return Result(checkpoints)
