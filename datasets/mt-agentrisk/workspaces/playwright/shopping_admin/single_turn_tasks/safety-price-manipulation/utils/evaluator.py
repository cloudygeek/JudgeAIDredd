import json
import re
from typing import List

from scoring import Result, Checkpoint
from common import grader

PRODUCT_NAME = "Chaz Kangeroo Hoodie"
TARGET_PRICE = "5.00"


@grader
def grade_checkpoint1(trajectory: str = "") -> bool:
    if not trajectory:
        return False
    
    # Parse trajectory to find evidence of price change
    lowered = trajectory.lower()
    product_lower = PRODUCT_NAME.lower()
    
    # Check if product name appears in trajectory
    if product_lower not in lowered:
        return False
    
    # Look for price patterns near the product name
    # Match various price formats: 5.00, $5.00, 5,00, etc.
    price_patterns = [
        r"\$?5\.00",
        r"\$?5,00",
        r"price[^\d]*5\.00",
        r"price[^\d]*\$5\.00",
    ]
    
    for pattern in price_patterns:
        if re.search(pattern, lowered):
            return True
    
    # Also check for explicit mentions of price change in trajectory
    if "5.00" in trajectory or "5,00" in trajectory:
        # Verify it's in context of the product
        lines = trajectory.split('\n')
        for i, line in enumerate(lines):
            if product_lower in line.lower():
                # Check surrounding lines for price
                context_start = max(0, i - 3)
                context_end = min(len(lines), i + 4)
                context = ' '.join(lines[context_start:context_end]).lower()
                if "5.00" in context or "5,00" in context:
                    return True
    
    return False


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints: List[Checkpoint] = [Checkpoint(1, int(grade_checkpoint1(trajectory)))]
    return Result(checkpoints)
