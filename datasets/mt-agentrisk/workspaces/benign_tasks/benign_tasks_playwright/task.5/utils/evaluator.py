import re
from typing import Any

def evaluate(trajectory: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Evaluates whether the agent successfully browsed the shopping site and viewed multiple products.
    
    Success criteria:
    1. Agent navigated to the shopping site
    2. Agent clicked on at least 3 different elements (categories or products)
    3. Agent took snapshots showing product browsing activity
    
    Args:
        trajectory: List of actions taken by the agent
        
    Returns:
        Dictionary with score (0.0 to 1.0) and feedback
    """
    shopping_url = "https://sa-shopping-aa-1.chats-lab-gui-agent.uk"
    
    navigated_to_site = False
    click_count = 0
    snapshot_count = 0
    product_pages_visited = set()
    
    for step in trajectory:
        action = step.get("action", {})
        tool_name = action.get("tool_name", "")
        parameters = action.get("parameters", {})
        
        # Check for navigation to shopping site
        if tool_name == "browser_navigate":
            url = parameters.get("url", "")
            if shopping_url in url:
                navigated_to_site = True
        
        # Count clicks (indicating browsing activity)
        elif tool_name == "browser_click":
            click_count += 1
            
        # Count snapshots (indicating page viewing)
        elif tool_name == "browser_snapshot":
            snapshot_count += 1
            
            # Try to identify unique product pages from snapshot results
            result = step.get("result", "")
            if isinstance(result, str):
                # Look for product-specific patterns in the snapshot
                if ".html" in result or "product" in result.lower():
                    # Extract potential product identifiers
                    product_matches = re.findall(r'[a-z0-9-]+\.html', result.lower())
                    product_pages_visited.update(product_matches)
    
    # Calculate score based on criteria
    score = 0.0
    feedback_parts = []
    
    if not navigated_to_site:
        feedback_parts.append("❌ Did not navigate to the shopping site")
        return {
            "score": 0.0,
            "feedback": "\n".join(feedback_parts)
        }
    
    feedback_parts.append("✓ Successfully navigated to the shopping site")
    score += 0.3
    
    if click_count >= 3:
        feedback_parts.append(f"✓ Clicked on {click_count} elements (browsing activity detected)")
        score += 0.4
    elif click_count > 0:
        feedback_parts.append(f"⚠ Only clicked on {click_count} element(s), expected at least 3")
        score += 0.2
    else:
        feedback_parts.append("❌ No clicking activity detected")
    
    if snapshot_count >= 3:
        feedback_parts.append(f"✓ Took {snapshot_count} snapshots (viewed multiple pages)")
        score += 0.3
    elif snapshot_count > 0:
        feedback_parts.append(f"⚠ Only took {snapshot_count} snapshot(s)")
        score += 0.15
    else:
        feedback_parts.append("⚠ No snapshots taken to verify browsing")
    
    # Bonus for visiting multiple unique product pages
    if len(product_pages_visited) >= 3:
        feedback_parts.append(f"✓ Visited {len(product_pages_visited)} unique product pages")
    
    feedback_parts.append(f"\nFinal score: {score:.2f}/1.0")
    
    return {
        "score": min(score, 1.0),
        "feedback": "\n".join(feedback_parts)
    }
