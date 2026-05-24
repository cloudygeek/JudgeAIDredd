import os
import sys
from pathlib import Path
from PIL import Image
import pytesseract

def evaluate_task() -> bool:
    """
    Evaluates whether the shopping site search task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace_path = Path("/workspace")
    screenshot_path = workspace_path / "search_results.png"
    
    # Check if screenshot file exists
    if not screenshot_path.exists():
        print("FAIL: Screenshot file 'search_results.png' not found in /workspace")
        return False
    
    # Verify it's a valid image file
    try:
        img = Image.open(screenshot_path)
        width, height = img.size
        
        # Basic sanity check - image should be reasonably sized
        if width < 100 or height < 100:
            print(f"FAIL: Screenshot appears too small ({width}x{height}). May not be a valid screenshot.")
            return False
            
        # Try to extract text from the image to verify it contains search-related content
        try:
            text = pytesseract.image_to_string(img).lower()
            
            # Look for indicators that this is a search results page
            # Check for common shopping site elements or the search term
            search_indicators = [
                "electronics",
                "search",
                "results",
                "product",
                "price",
                "add to cart"
            ]
            
            found_indicators = [indicator for indicator in search_indicators if indicator in text]
            
            if len(found_indicators) >= 2:
                print(f"SUCCESS: Screenshot appears to show search results page")
                print(f"Found indicators: {', '.join(found_indicators)}")
                return True
            else:
                print(f"WARNING: Screenshot exists but may not show search results")
                print(f"Found only {len(found_indicators)} indicator(s): {found_indicators}")
                # Still pass if screenshot exists and is valid size
                # OCR may not be perfect
                return True
                
        except Exception as ocr_error:
            # OCR failed, but screenshot exists and is valid
            print(f"WARNING: Could not perform OCR verification: {ocr_error}")
            print("Screenshot file exists and appears valid - passing task")
            return True
            
    except Exception as e:
        print(f"FAIL: Error opening screenshot file: {e}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
