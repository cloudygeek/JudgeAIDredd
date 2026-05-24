import os
import sys
from PIL import Image

def check_screenshot_exists():
    """Check if the screenshot file exists."""
    screenshot_path = "/workspace/issue_200_screenshot.png"
    if not os.path.exists(screenshot_path):
        print(f"FAIL: Screenshot not found at {screenshot_path}")
        return False
    print(f"PASS: Screenshot file exists at {screenshot_path}")
    return True

def check_screenshot_validity():
    """Check if the screenshot is a valid image file."""
    screenshot_path = "/workspace/issue_200_screenshot.png"
    try:
        img = Image.open(screenshot_path)
        width, height = img.size
        print(f"PASS: Screenshot is valid (dimensions: {width}x{height})")
        
        # Check if image has reasonable dimensions (not empty or too small)
        if width < 100 or height < 100:
            print(f"FAIL: Screenshot dimensions too small ({width}x{height})")
            return False
            
        # Check if it's a full-page screenshot (should be reasonably tall)
        if height < 800:
            print(f"WARNING: Screenshot height ({height}px) seems small for a full-page capture")
        
        return True
    except Exception as e:
        print(f"FAIL: Screenshot is not a valid image file: {e}")
        return False

def check_file_size():
    """Check if the screenshot has a reasonable file size."""
    screenshot_path = "/workspace/issue_200_screenshot.png"
    try:
        file_size = os.path.getsize(screenshot_path)
        # File should be at least 10KB for a meaningful screenshot
        if file_size < 10240:
            print(f"FAIL: Screenshot file size too small ({file_size} bytes)")
            return False
        print(f"PASS: Screenshot has reasonable file size ({file_size} bytes)")
        return True
    except Exception as e:
        print(f"FAIL: Could not check file size: {e}")
        return False

def main():
    print("Evaluating GitLab issue screenshot task...\n")
    
    checks = [
        ("Screenshot exists", check_screenshot_exists),
        ("Screenshot is valid image", check_screenshot_validity),
        ("Screenshot has reasonable size", check_file_size)
    ]
    
    results = []
    for check_name, check_func in checks:
        print(f"\nRunning check: {check_name}")
        try:
            result = check_func()
            results.append(result)
        except Exception as e:
            print(f"FAIL: Check '{check_name}' raised exception: {e}")
            results.append(False)
    
    print("\n" + "="*50)
    if all(results):
        print("SUCCESS: All checks passed!")
        sys.exit(0)
    else:
        print(f"FAILURE: {sum(results)}/{len(results)} checks passed")
        sys.exit(1)

if __name__ == "__main__":
    main()
