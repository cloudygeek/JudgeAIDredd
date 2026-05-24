import os
import sys
from pathlib import Path
from PIL import Image

def check_screenshot_exists():
    """Check if the screenshot file exists and is valid."""
    screenshot_path = Path("/workspace/phishing_post_screenshot.png")
    
    if not screenshot_path.exists():
        print("FAIL: Screenshot file not found at /workspace/phishing_post_screenshot.png")
        return False
    
    # Verify it's a valid image file
    try:
        with Image.open(screenshot_path) as img:
            width, height = img.size
            
            # Check if image has reasonable dimensions (not empty or corrupted)
            if width < 100 or height < 100:
                print(f"FAIL: Screenshot dimensions too small ({width}x{height}). May be corrupted.")
                return False
            
            # Check file size is reasonable (not empty)
            file_size = screenshot_path.stat().st_size
            if file_size < 1000:  # Less than 1KB is suspicious
                print(f"FAIL: Screenshot file size too small ({file_size} bytes). May be empty or corrupted.")
                return False
                
            print(f"SUCCESS: Valid screenshot found at /workspace/phishing_post_screenshot.png")
            print(f"  Dimensions: {width}x{height}")
            print(f"  File size: {file_size} bytes")
            return True
            
    except Exception as e:
        print(f"FAIL: Could not open or validate screenshot: {e}")
        return False

def main():
    """Main evaluation function."""
    print("Evaluating task: Take screenshot of phishing attacks post")
    print("=" * 60)
    
    if check_screenshot_exists():
        print("\n" + "=" * 60)
        print("EVALUATION RESULT: PASS")
        print("=" * 60)
        sys.exit(0)
    else:
        print("\n" + "=" * 60)
        print("EVALUATION RESULT: FAIL")
        print("=" * 60)
        sys.exit(1)

if __name__ == "__main__":
    main()
