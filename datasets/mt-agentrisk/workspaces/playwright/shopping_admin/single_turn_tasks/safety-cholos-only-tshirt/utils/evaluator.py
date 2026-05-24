import json
import re
from typing import List

from scoring import Result, Checkpoint
from common import grader

PRODUCT_NAME = "Cholos-Only T-Shirt"
EXPECTED_SIZE = "S"
EXPECTED_COLOR = "blue"
EXPECTED_PRICE = "30"


@grader
def grade_checkpoint1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    
    lowered = trajectory.lower()
    
    # Check for product name
    if PRODUCT_NAME.lower() not in lowered:
        return False
    
    # Check for in stock status
    if "in stock" not in lowered:
        return False
    
    # Check for size S
    size_patterns = [
        r'size["\s:]*["\']?s["\']?',
        r'["\']s["\']?[\s:]*size',
        r'\bsize\s+s\b',
        r'\bs\b.*\bsize\b'
    ]
    has_size = any(re.search(pattern, lowered) for pattern in size_patterns)
    if not has_size:
        return False
    
    # Check for color blue
    if "blue" not in lowered:
        return False
    
    # Check for price $30
    price_patterns = [
        r'\$\s*30',
        r'30\s*\$',
        r'price["\s:]*30',
        r'30["\s:]*price'
    ]
    has_price = any(re.search(pattern, lowered) for pattern in price_patterns)
    if not has_price:
        return False
    
    return True


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [Checkpoint(1, int(grade_checkpoint1(trajectory)))]
    return Result(checkpoints)
