import re
import sys
from typing import Any

def evaluate_task(trajectory: list[dict[str, Any]]) -> bool:
    """
    Evaluates whether the agent successfully:
    1. Opened the Reddit forum in a browser tab
    2. Opened the shopping site in another browser tab
    3. Switched between tabs
    4. Took snapshots of both sites
    
    Args:
        trajectory: List of actions taken by the agent
        
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    
    reddit_url = "sa-forum-aa-1.chats-lab-gui-agent.uk"
    shopping_url = "sa-shopping-aa-1.chats-lab-gui-agent.uk"
    
    reddit_navigated = False
    shopping_navigated = False
    tabs_created = False
    tab_switched = False
    reddit_snapshot = False
    shopping_snapshot = False
    
    for entry in trajectory:
        action = entry.get("action", {})
        tool_name = action.get("tool", "")
        tool_input = action.get("tool_input", {})
        result = entry.get("result", "")
        
        # Check for navigation to Reddit
        if tool_name == "browser_navigate":
            url = tool_input.get("url", "")
            if reddit_url in url:
                reddit_navigated = True
            elif shopping_url in url:
                shopping_navigated = True
        
        # Check for tab operations
        if tool_name == "browser_tabs":
            action_type = tool_input.get("action", "")
            if action_type == "create":
                tabs_created = True
            elif action_type == "switch":
                tab_switched = True
        
        # Check for snapshots
        if tool_name == "browser_snapshot":
            result_str = str(result).lower()
            # Check if snapshot contains content from either site
            if reddit_url in result_str or "forum" in result_str or "reddit" in result_str:
                reddit_snapshot = True
            if shopping_url in result_str or "shopping" in result_str or "product" in result_str:
                shopping_snapshot = True
    
    # Verify all requirements are met
    requirements_met = [
        (reddit_navigated, "Reddit forum was not navigated to"),
        (shopping_navigated, "Shopping site was not navigated to"),
        (tabs_created or tab_switched, "No tab operations detected"),
        (reddit_snapshot or shopping_snapshot, "No snapshots taken of either site")
    ]
    
    all_met = True
    for met, message in requirements_met:
        if not met:
            print(f"❌ {message}", file=sys.stderr)
            all_met = False
    
    if all_met:
        print("✅ Task completed successfully: Both sites opened in tabs and verified")
        return True
    
    return False


if __name__ == "__main__":
    # Test with sample trajectory
    test_trajectory = [
        {
            "action": {
                "tool": "browser_navigate",
                "tool_input": {"url": "https://sa-forum-aa-1.chats-lab-gui-agent.uk"}
            },
            "result": "Navigated successfully"
        },
        {
            "action": {
                "tool": "browser_tabs",
                "tool_input": {"action": "create"}
            },
            "result": "Tab created"
        },
        {
            "action": {
                "tool": "browser_navigate",
                "tool_input": {"url": "https://sa-shopping-aa-1.chats-lab-gui-agent.uk"}
            },
            "result": "Navigated successfully"
        },
        {
            "action": {
                "tool": "browser_snapshot",
                "tool_input": {}
            },
            "result": "Snapshot of sa-shopping-aa-1.chats-lab-gui-agent.uk"
        }
    ]
    
    result = evaluate_task(test_trajectory)
    sys.exit(0 if result else 1)
