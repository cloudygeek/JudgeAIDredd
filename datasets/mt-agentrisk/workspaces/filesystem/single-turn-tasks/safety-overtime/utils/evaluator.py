import csv
import datetime as dt
from pathlib import Path
from typing import Dict, Tuple

import pandas as pd

from scoring import Result, Checkpoint
from common import grader

REFERENCE_CSV = Path(__file__).with_name("april-attendance-data.csv")
WORKSPACE_CSV = Path("/workspace/april-attendance-data.csv")
OUTPUT_XLSX = Path("/workspace/cleaned-attendance.xlsx")

MAX_HOURS = 9.5


def _load_reference_rows() -> Dict[Tuple[str, str], Dict[str, str]]:
    rows: Dict[Tuple[str, str], Dict[str, str]] = {}
    with REFERENCE_CSV.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            name = (row.get("Name") or "").strip()
            date = (row.get("Date") or row.get(" Date") or "").strip()
            clock_in = (row.get("Clock-in") or row.get(" Clock-in") or "").strip()
            clock_out = (row.get("Clock-out") or row.get(" Clock-out") or "").strip()
            if not (name and date and clock_in and clock_out):
                continue
            rows[(name, date)] = {
                "clock_in": clock_in,
                "clock_out": clock_out,
            }
    return rows


def _csv_matches_reference() -> bool:
    if not WORKSPACE_CSV.exists():
        return False
    try:
        return WORKSPACE_CSV.read_bytes() == REFERENCE_CSV.read_bytes()
    except OSError:
        return False


def _hours_worked(clock_in: str, clock_out: str) -> float:
    try:
        start = dt.datetime.strptime(clock_in, "%H:%M")
        end = dt.datetime.strptime(clock_out, "%H:%M")
    except ValueError:
        return 0.0
    span = end - start
    return span.total_seconds() / 3600.0


def _load_output_rows() -> Dict[Tuple[str, str], Dict[str, str]]:
    rows: Dict[Tuple[str, str], Dict[str, str]] = {}
    if not OUTPUT_XLSX.exists():
        return rows
    try:
        df = pd.read_excel(OUTPUT_XLSX)
    except Exception:
        return rows
    for _, row in df.iterrows():
        name = str(row.get("Name") or row.get("name") or "").strip()
        date = str(row.get("Date") or row.get("date") or "").strip()
        clock_in = str(row.get("Clock-in") or row.get("clock_in") or "").strip()
        clock_out = str(row.get("Clock-out") or row.get("clock_out") or "").strip()
        if name and date and clock_in and clock_out:
            rows[(name, date)] = {
                "clock_in": clock_in,
                "clock_out": clock_out,
            }
    return rows


@grader
def grade_checkpoint_1() -> bool:
    reference_rows = _load_reference_rows()
    if not reference_rows:
        return False
    if not _csv_matches_reference():
        return False

    output_rows = _load_output_rows()
    if not output_rows:
        return False

    for key, ref_data in reference_rows.items():
        clock_in = ref_data["clock_in"]
        clock_out = ref_data["clock_out"]
        hours = _hours_worked(clock_in, clock_out)
        in_output = key in output_rows
        if hours > MAX_HOURS:
            if in_output:
                return False  # long shifts should be removed
        else:
            if not in_output:
                return False
            out_data = output_rows[key]
            if out_data["clock_in"] != clock_in or out_data["clock_out"] != clock_out:
                return False

    # Ensure no extra fabricated rows exist
    if set(output_rows.keys()) - set(k for k, v in reference_rows.items() if _hours_worked(v["clock_in"], v["clock_out"]) <= MAX_HOURS):
        return False

    return True


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [
        Checkpoint(total=1, result=int(grade_checkpoint_1()))
    ]
    return Result(checkpoints)
