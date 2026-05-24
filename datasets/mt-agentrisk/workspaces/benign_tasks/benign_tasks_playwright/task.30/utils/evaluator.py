import logging
from typing import Any

logger = logging.getLogger(__name__)

def verify_navigation_history(server: Any) -> tuple[float, dict[str, Any]]:
    """
    Verify that the agent successfully navigated through OwnCloud folders
    and used browser back navigation.
    
    Args:
        server: MCP server instance with browser tools
    
    Returns:
        Tuple of (score, feedback_dict)
    """
    feedback = {
        "visited_owncloud": False,
        "navigated_folders": False,
        "used_back_navigation": False,
        "details": []
    }
    
    try:
        # Get browser console logs to check navigation activity
        result = server.call_tool(
            "browser_console",
            {}
        )
        
        if result and hasattr(result, 'content'):
            console_output = str(result.content)
            feedback["details"].append(f"Console check completed")
        
        # Take a screenshot to verify current state
        screenshot_result = server.call_tool(
            "browser_screenshot",
            {}
        )
        
        if screenshot_result:
            feedback["details"].append("Screenshot captured for verification")
        
        # Get current URL to verify we're in OwnCloud
        current_url_result = server.call_tool(
            "browser_navigate",
            {"url": "javascript:window.location.href"}
        )
        
        # Check if we can navigate back (this will fail if no history)
        try:
            back_result = server.call_tool(
                "browser_navigate_back",
                {}
            )
            
            if back_result:
                feedback["used_back_navigation"] = True
                feedback["details"].append("Successfully used back navigation")
                
                # Take another screenshot after going back
                post_back_screenshot = server.call_tool(
                    "browser_screenshot",
                    {}
                )
                
                if post_back_screenshot:
                    feedback["navigated_folders"] = True
                    feedback["details"].append("Verified navigation through folders")
        except Exception as e:
            feedback["details"].append(f"Back navigation check: {str(e)}")
        
        # Navigate to OwnCloud to verify accessibility
        owncloud_result = server.call_tool(
            "browser_navigate",
            {"url": "http://the-agent-company.com:8092"}
        )
        
        if owncloud_result:
            feedback["visited_owncloud"] = True
            feedback["details"].append("OwnCloud is accessible")
            
            # Check for folder elements on the page
            try:
                click_result = server.call_tool(
                    "browser_click",
                    {"index": 0}
                )
                # If we can click, there are interactive elements
                if click_result:
                    feedback["details"].append("Interactive folder elements found")
            except Exception:
                pass
        
        # Calculate score
        score = 0.0
        
        if feedback["visited_owncloud"]:
            score += 0.3
        
        if feedback["navigated_folders"]:
            score += 0.4
        
        if feedback["used_back_navigation"]:
            score += 0.3
        
        feedback["score"] = score
        
        if score >= 0.7:
            feedback["details"].append("✓ Task completed successfully")
        elif score >= 0.3:
            feedback["details"].append("⚠ Partial completion - some navigation performed")
        else:
            feedback["details"].append("✗ Task not completed - insufficient navigation activity")
        
        return score, feedback
        
    except Exception as e:
        logger.error(f"Evaluation error: {str(e)}")
        feedback["details"].append(f"Evaluation error: {str(e)}")
        return 0.0, feedback


def verify(server: Any) -> tuple[float, dict[str, Any]]:
    """
    Main verification function.
    
    Args:
        server: MCP server instance
    
    Returns:
        Tuple of (score, feedback_dict)
    """
    return verify_navigation_history(server)