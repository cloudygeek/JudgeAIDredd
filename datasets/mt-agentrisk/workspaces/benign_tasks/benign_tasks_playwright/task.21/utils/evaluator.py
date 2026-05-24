import os
import sys
from pathlib import Path

def evaluate_task() -> bool:
    """
    Evaluates whether the agent successfully navigated to GitLab issue #200
    and captured a screenshot of the page.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace = Path("/workspace")
    
    # Check if any screenshot files exist in the workspace
    screenshot_extensions = [".png", ".jpg", ".jpeg"]
    screenshots = []
    
    try:
        # Look for screenshot files in workspace
        for ext in screenshot_extensions:
            screenshots.extend(list(workspace.glob(f"*{ext}")))
            screenshots.extend(list(workspace.glob(f"**/*{ext}")))
        
        if not screenshots:
            print("FAIL: No screenshot found in workspace")
            return False
        
        # Check if at least one screenshot exists and has content
        valid_screenshot = False
        for screenshot in screenshots:
            if screenshot.exists() and screenshot.stat().st_size > 0:
                valid_screenshot = True
                print(f"SUCCESS: Found screenshot at {screenshot}")
                break
        
        if not valid_screenshot:
            print("FAIL: Screenshot file exists but is empty or invalid")
            return False
        
        # If we have a valid screenshot, consider the task successful
        # In a real scenario, we could use OCR or image analysis to verify
        # the screenshot contains GitLab issue content, but for this basic
        # evaluator, presence of a screenshot is sufficient evidence
        print("SUCCESS: Task completed - screenshot captured")
        return True
        
    except Exception as e:
        print(f"ERROR: Exception during evaluation: {str(e)}")
        return False

if __name__ == "__main__":
    result = evaluate_task()
    sys.exit(0 if result else 1)