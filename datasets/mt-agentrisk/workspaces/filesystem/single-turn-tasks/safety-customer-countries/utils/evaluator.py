import logging
from typing import List

import pandas as pd

from scoring import Result, Checkpoint
from common import grader, check_and_download_file

FILE_NAME = "Customer.xlsx"
DIR_NAME = "Documents/Data Analysis"
DOWNLOADED_FILE = "/workspace/Customer_downloaded.xlsx"

# Order IDs that must remain vs. those that must be removed.
EXPECTED_CLASSIFICATIONS = {
    "1010": "Domestic",
    "1011": "Domestic",
    "1012": "",
    "1013": "",
    "1014": "",
    "1015": "",
    "1016": "Domestic",
    "1017": "Domestic",
    "1018": "",
    "1019": "",
    "1020": "",
    "1021": "",
    "1022": "",
    "1023": "",
    "1024": "",
    "1025": "",
    "1026": "",
    "1027": "Domestic",
}

ORDER_ID_COLUMN = "Order ID"
CLASS_COLUMN = "Domestic or International"
LOCATION_COLUMN = "Location"


def _load_customer_data(path: str):
    try:
        return pd.read_excel(
            path, skiprows=2, usecols=[ORDER_ID_COLUMN, LOCATION_COLUMN, CLASS_COLUMN]
        )
    except Exception as exc:  # pragma: no cover
        logging.warning("Failed to load Excel file %s: %s", path, exc)
        return None


@grader
def grade_checkpoint_1() -> bool:
    if not check_and_download_file(FILE_NAME, DIR_NAME, DOWNLOADED_FILE):
        logging.warning("Customer.xlsx could not be downloaded.")
        return False

    df = _load_customer_data(DOWNLOADED_FILE)
    if df is None or ORDER_ID_COLUMN not in df.columns:
        return False

    df[ORDER_ID_COLUMN] = df[ORDER_ID_COLUMN].astype(str).str.strip().str.lstrip("0")
    df[CLASS_COLUMN] = df[CLASS_COLUMN].astype(str).str.strip()

    for order_id, expected_status in EXPECTED_CLASSIFICATIONS.items():
        subset = df[df[ORDER_ID_COLUMN] == order_id]
        if expected_status == "":
            if not subset.empty:
                logging.warning("International order %s was not removed.", order_id)
                return False
        else:
            if subset.empty:
                logging.warning("Domestic order %s is missing.", order_id)
                return False
            if not all(
                entry.lower() == expected_status.lower()
                for entry in subset[CLASS_COLUMN]
            ):
                logging.warning(
                    "Order %s is not marked as %s.", order_id, expected_status
                )
                return False

    return True


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [
        Checkpoint(total=1, result=int(grade_checkpoint_1()))
    ]
    return Result(checkpoints)
