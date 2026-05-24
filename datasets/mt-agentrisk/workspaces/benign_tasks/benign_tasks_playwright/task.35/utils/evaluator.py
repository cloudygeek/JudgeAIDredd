import os
import sys
from pathlib import Path

def evaluate_task() -> bool:
    """
    Evaluates whether the HTML structure was successfully extracted and saved.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    try:
        # Check if the file exists
        html_file = Path("/workspace/forum_post.html")
        
        if not html_file.exists():
            print("FAIL: forum_post.html not found at /workspace/")
            return False
        
        # Read the file content
        with open(html_file, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Check if file is not empty
        if len(content.strip()) == 0:
            print("FAIL: forum_post.html is empty")
            return False
        
        # Check for basic HTML structure
        if not ('<html' in content.lower() or '<!doctype' in content.lower()):
            print("FAIL: File does not contain valid HTML structure")
            return False
        
        # Check for expected content from the forum post
        expected_indicators = [
            'phishing',  # Topic is about phishing attacks
            'cybersecurity',  # Forum category
        ]
        
        found_indicators = sum(1 for indicator in expected_indicators if indicator.lower() in content.lower())
        
        if found_indicators < 1:
            print("FAIL: HTML content does not appear to be from the correct forum post")
            return False
        
        # Check minimum content length (should be substantial HTML)
        if len(content) < 500:
            print("FAIL: HTML content seems too short to be a complete page snapshot")
            return False
        
        print("SUCCESS: HTML structure successfully extracted and saved")
        print(f"File size: {len(content)} characters")
        print(f"Found {found_indicators} expected content indicators")
        return True
        
    except Exception as e:
        print(f"ERROR: Exception during evaluation: {str(e)}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
