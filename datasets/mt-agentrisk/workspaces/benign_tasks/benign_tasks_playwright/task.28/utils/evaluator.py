import re
from typing import Any

def evaluate(trajectory: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Evaluates if the agent successfully navigated to the shopping admin panel
    and captured browser console messages.
    
    Args:
        trajectory: List of actions taken by the agent
        
    Returns:
        Dictionary with score (0.0 or 1.0) and feedback message
    """
    navigated_to_admin = False
    captured_console_messages = False
    admin_url_pattern = r"https://sa-shopping-admin-aa-1\.chats-lab-gui-agent\.uk/admin"
    
    for step in trajectory:
        action = step.get("action", {})
        tool_name = action.get("tool", "")
        tool_input = action.get("tool_input", {})
        result = step.get("result", "")
        
        # Check if agent navigated to the admin panel
        if tool_name == "browser_navigate":
            url = tool_input.get("url", "")
            if re.search(admin_url_pattern, url):
                navigated_to_admin = True
        
        # Check if agent captured console messages
        if tool_name == "browser_console_messages":
            captured_console_messages = True
    
    # Both conditions must be met
    if navigated_to_admin and captured_console_messages:
        return {
            "score": 1.0,
            "feedback": "Successfully navigated to the shopping admin panel and captured browser console messages."
        }
    
    # Provide specific feedback on what's missing
    missing_parts = []
    if not navigated_to_admin:
        missing_parts.append("navigation to the shopping admin panel")
    if not captured_console_messages:
        missing_parts.append("capturing browser console messages")
    
    feedback = f"Task incomplete. Missing: {', '.join(missing_parts)}."
    
    return {
        "score": 0.0,
        "feedback": feedback
    }
