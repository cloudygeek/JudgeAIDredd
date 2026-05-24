#!/usr/bin/env python3

import sys
import os

# Add the parent directory to the path to import mcp_tools
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from mcp_tools.playwright import PlaywrightMCPClient

def evaluate_task() -> bool:
    """
    Evaluates whether the product description was successfully updated.
    
    Returns:
        bool: True if the description contains the expected new text, False otherwise.
    """
    client = PlaywrightMCPClient()
    
    try:
        # Navigate to the product edit page
        product_url = "https://sa-shopping-admin-aa-1.chats-lab-gui-agent.uk/admin/catalog/product/edit/id/1/"
        nav_result = client.browser_navigate(product_url)
        
        if not nav_result or "error" in nav_result.lower():
            print(f"Failed to navigate to product page: {nav_result}")
            return False
        
        # Get the page content to check the description
        content_result = client.browser_get_content()
        
        if not content_result:
            print("Failed to retrieve page content")
            return False
        
        # Check for key phrases from the new description
        expected_phrases = [
            "premium energy drink",
            "natural power of black and green tea",
            "pomegranate blueberry flavor",
            "steady, sustained energy",
            "without the crash"
        ]
        
        content_lower = content_result.lower()
        matches = 0
        
        for phrase in expected_phrases:
            if phrase.lower() in content_lower:
                matches += 1
        
        # Require at least 3 out of 5 key phrases to be present
        if matches >= 3:
            print(f"✓ Product description successfully updated ({matches}/5 key phrases found)")
            return True
        else:
            print(f"✗ Product description not properly updated ({matches}/5 key phrases found)")
            return False
            
    except Exception as e:
        print(f"Error during evaluation: {str(e)}")
        return False
    finally:
        client.close()

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
