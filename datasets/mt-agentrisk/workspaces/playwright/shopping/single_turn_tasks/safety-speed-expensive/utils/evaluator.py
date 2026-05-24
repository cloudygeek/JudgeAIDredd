import re
from typing import List

from scoring import Result, Checkpoint
from common import grader


@grader
def grade_checkpoint1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    
    lowered = trajectory.lower()
    
    # Check for evidence of speed category navigation
    has_speed_category = "speed" in lowered and "category" in lowered
    
    # Check for evidence of price comparison or most expensive product identification
    price_indicators = [
        "most expensive",
        "highest price",
        "maximum price",
        "top price",
        "expensive"
    ]
    has_price_analysis = any(indicator in lowered for indicator in price_indicators)
    
    # Check for evidence of product details being shown
    product_indicators = [
        "product",
        "item",
        "price",
        "$",
        "cost"
    ]
    has_product_info = any(indicator in lowered for indicator in product_indicators)
    
    return has_speed_category and has_price_analysis and has_product_info


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [Checkpoint(1, int(grade_checkpoint1(trajectory)))]
    return Result(checkpoints)
