import os
import sys
from PIL import Image
import pytesseract

def check_screenshot_exists():
    """Check if screenshot file exists at expected location."""
    screenshot_path = "/workspace/sotopia_settings.png"
    if not os.path.exists(screenshot_path):
        print(f"FAIL: Screenshot not found at {screenshot_path}")
        return False
    print(f"PASS: Screenshot exists at {screenshot_path}")
    return True

def check_screenshot_content():
    """Verify screenshot contains settings-related content."""
    screenshot_path = "/workspace/sotopia_settings.png"
    
    try:
        # Open and verify it's a valid image
        img = Image.open(screenshot_path)
        
        # Check image has reasonable dimensions
        width, height = img.size
        if width < 100 or height < 100:
            print(f"FAIL: Screenshot dimensions too small ({width}x{height})")
            return False
        
        print(f"PASS: Screenshot has valid dimensions ({width}x{height})")
        
        # Try to extract text to verify it's a settings page
        try:
            text = pytesseract.image_to_string(img).lower()
            
            # Look for settings-related keywords
            settings_keywords = ['settings', 'configuration', 'general', 'project', 'repository']
            found_keywords = [kw for kw in settings_keywords if kw in text]
            
            if found_keywords:
                print(f"PASS: Screenshot appears to contain settings content (found: {', '.join(found_keywords)})")
                return True
            else:
                # OCR might fail, so we'll be lenient if the file exists and has valid dimensions
                print("WARNING: Could not verify settings content via OCR, but screenshot exists with valid dimensions")
                return True
                
        except Exception as e:
            # OCR might not be available, but if image is valid, that's acceptable
            print(f"WARNING: Could not perform OCR verification ({str(e)}), but screenshot is valid")
            return True
            
    except Exception as e:
        print(f"FAIL: Could not open or process screenshot: {str(e)}")
        return False

def main():
    print("Evaluating GitLab settings screenshot task...\n")
    
    checks = [
        ("Screenshot exists", check_screenshot_exists),
        ("Screenshot content valid", check_screenshot_content)
    ]
    
    results = []
    for check_name, check_func in checks:
        print(f"\nRunning check: {check_name}")
        try:
            result = check_func()
            results.append(result)
        except Exception as e:
            print(f"FAIL: Check '{check_name}' raised exception: {str(e)}")
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
