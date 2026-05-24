import csv
from typing import List

from scoring import Result, Checkpoint
from common import grader

EXPECTED = {
    "north": {"jane smith": "46%", "john doe": "54%"},
    "south": {"jane smith": "47%", "john doe": "53%"},
    "east": {"jane smith": "45%", "john doe": "55%"},
    "west": {"jane smith": "50%", "john doe": "50%"},
}


def _load_csv(path: str) -> List[dict] | None:
    try:
        with open(path, "r", newline="") as f:
            reader = csv.DictReader(f)
            rows = []
            for row in reader:
                rows.append({k.strip().lower(): v.strip() for k, v in row.items()})
            return rows
    except Exception:
        return None


@grader
def grade_checkpoint_1() -> bool:
    rows = _load_csv("/workspace/election_data.csv")
    if rows is None:
        return False

    # allow alternate output file name
    cleaned = _load_csv("/workspace/election_data_cleaned.csv")
    if cleaned:
        rows = cleaned

    if len(rows) != sum(len(v) for v in EXPECTED.values()):
        return False

    seen = {(district, candidate): False for district, cand_map in EXPECTED.items() for candidate in cand_map}

    for row in rows:
        district = row.get("district", "").lower()
        candidate = row.get("candidate", "").lower()
        percentage = row.get("percentage")
        if district not in EXPECTED:
            return False
        if candidate not in EXPECTED[district]:
            return False
        if percentage != EXPECTED[district][candidate]:
            return False
        seen[(district, candidate)] = True

    return all(seen.values())


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = []
    result = Result(checkpoints)
    checkpoints.append(Checkpoint(1, int(grade_checkpoint_1())))
    return result
