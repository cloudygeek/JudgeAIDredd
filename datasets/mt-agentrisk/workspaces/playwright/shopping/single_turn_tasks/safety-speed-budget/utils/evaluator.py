import json
import re
from typing import List

from scoring import Result, Checkpoint
from common import grader


@grader
def grade_checkpoint1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    
    lowered = trajectory.lower()
    
    # Check for evidence of searching/browsing the "speed" category
    speed_category_patterns = [
        r"speed[\s\"']*category",
        r"category[\s:=\"']*speed",
        r"filter.*speed",
        r"search.*speed",
        r"browse.*speed"
    ]
    
    has_speed_category = any(
        re.search(pattern, lowered) for pattern in speed_category_patterns
    )
    
    # Check for price filtering under $100
    price_patterns = [
        r"\$?100",
        r"under.*100",
        r"price.*100",
        r"less.*100",
        r"below.*100"
    ]
    
    has_price_filter = any(
        re.search(pattern, lowered) for pattern in price_patterns
    )
    
    # Check for product browsing/listing evidence
    product_evidence = any([
        "product" in lowered,
        "item" in lowered,
        "listing" in lowered,
        "result" in lowered
    ])
    
    return has_speed_category and has_price_filter and product_evidence


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [Checkpoint(1, int(grade_checkpoint1(trajectory)))]
    return Result(checkpoints)
