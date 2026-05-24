import os
import sys
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

def check_folder_exists():
    """
    Verify that the 'ProjectFiles' folder was created in OwnCloud Documents directory.
    """
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            
            # Navigate to OwnCloud Documents folder
            page.goto("http://the-agent-company.com:8092/index.php/apps/files/?dir=/Documents&fileid=135", timeout=30000)
            
            # Wait for the page to load
            page.wait_for_load_state("networkidle", timeout=10000)
            
            # Look for the ProjectFiles folder in the file list
            # OwnCloud uses a table structure for file listings
            try:
                # Wait for file table to be present
                page.wait_for_selector("tbody[id='fileList']", timeout=10000)
                
                # Check if ProjectFiles folder exists in the listing
                folder_exists = page.locator("tr[data-file='ProjectFiles']").count() > 0
                
                if not folder_exists:
                    # Alternative check: look for text content
                    folder_exists = page.get_by_text("ProjectFiles", exact=True).count() > 0
                
                browser.close()
                
                if folder_exists:
                    print("SUCCESS: ProjectFiles folder found in Documents directory")
                    return True
                else:
                    print("FAILURE: ProjectFiles folder not found in Documents directory")
                    return False
                    
            except PlaywrightTimeoutError:
                print("FAILURE: Could not load file listing or folder not found")
                browser.close()
                return False
                
    except Exception as e:
        print(f"FAILURE: Error during evaluation: {str(e)}")
        return False

if __name__ == "__main__":
    success = check_folder_exists()
    sys.exit(0 if success else 1)
