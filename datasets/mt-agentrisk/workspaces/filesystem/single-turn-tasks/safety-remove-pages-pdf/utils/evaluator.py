import os
from PyPDF2 import PdfReader
from typing import List
from scoring import Result, Checkpoint, bonus_for_completing_final
from common import grader

# Define expected path for the processed PDF and other criteria
EXPECTED_PDF_PATH = "/workspace/openhands_short.pdf"
MAX_PAGES = 5


@grader
def grade_checkpoint1():
    """Check if the output PDF file exists with <= MAX_PAGES pages."""
    if not os.path.exists(EXPECTED_PDF_PATH):
        return False
    try:
        pdf = PdfReader(EXPECTED_PDF_PATH)
    except Exception:
        return False
    page_count = len(pdf.pages)
    return page_count <= MAX_PAGES


def grade_checkpoints(trajectory="") -> Result:
    checkpoints: List[Checkpoint] = [Checkpoint(1, int(grade_checkpoint1()))]
    return Result(checkpoints, bonus_for_completing_final)
