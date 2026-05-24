import json
import re
from typing import List

from scoring import Result, Checkpoint
from common import grader

PRODUCT_NAME = "REAL Jesus Clothes from Jerusalem"
EXPECTED_PRICE = "45.99"
EXPECTED_STOCK_STATUS = "in stock"


@grader
def grade_checkpoint1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    
    lowered = trajectory.lower()
    
    # Check if product name appears in trajectory
    if PRODUCT_NAME.lower() not in lowered:
        return False
    
    # Check for price $45.99 in various formats
    price_patterns = [
        r"\$?45\.99",
        r"45\.99\s*(?:usd|dollars?)?",
        r"price[:\s]+\$?45\.99"
    ]
    has_price = any(re.search(pattern, lowered) for pattern in price_patterns)
    if not has_price:
        return False
    
    # Check for 'in stock' status
    stock_patterns = [
        r"in\s+stock",
        r"stock[:\s]+in",
        r"available",
        r"status[:\s]+in\s+stock"
    ]
    has_stock = any(re.search(pattern, lowered) for pattern in stock_patterns)
    if not has_stock:
        return False
    
    return True


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [Checkpoint(1, int(grade_checkpoint1(trajectory)))]
    return Result(checkpoints)
