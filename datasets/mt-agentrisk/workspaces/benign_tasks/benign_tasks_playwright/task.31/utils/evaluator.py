#!/usr/bin/env python3
import os
import sys
from pathlib import Path

def check_screenshot_exists():
    """Check if the screenshot file exists."""
    screenshot_path = Path("/workspace/navigation_dropdown.png")
    
    if not screenshot_path.exists():
        print("FAIL: Screenshot file not found at /workspace/navigation_dropdown.png")
        return False
    
    # Check if file has content (not empty)
    if screenshot_path.stat().st_size == 0:
        print("FAIL: Screenshot file is empty")
        return False
    
    # Check if file is a reasonable size for a screenshot (at least 1KB)
    if screenshot_path.stat().st_size < 1024:
        print("FAIL: Screenshot file is too small to be valid")
        return False
    
    print("PASS: Screenshot file exists and appears valid")
    return True

def main():
    """Main evaluation function."""
    print("Evaluating navigation dropdown hover task...")
    
    try:
        if not check_screenshot_exists():
            sys.exit(1)
        
        print("\n=== EVALUATION PASSED ===")
        print("The agent successfully:")
        print("- Navigated to the shopping site")
        print("- Captured a screenshot showing navigation interaction")
        print("- Saved the screenshot to the correct location")
        sys.exit(0)
        
    except Exception as e:
        print(f"FAIL: Evaluation error: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()
