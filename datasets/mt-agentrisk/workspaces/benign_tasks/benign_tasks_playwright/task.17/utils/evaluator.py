import os
import sys
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

def check_file_uploaded():
    """
    Verify that report.pdf has been uploaded to the Documents folder in OwnCloud.
    """
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            
            # Navigate to OwnCloud Documents folder
            page.goto("http://the-agent-company.com:8092/index.php/apps/files/?dir=/Documents&fileid=135", timeout=30000)
            
            # Wait for the file list to load
            page.wait_for_selector(".files-fileList", timeout=10000)
            
            # Look for report.pdf in the file list
            # Check for the file name in various possible selectors
            file_found = False
            
            # Try to find the file by text content
            try:
                file_element = page.locator("text=report.pdf").first
                if file_element.is_visible(timeout=5000):
                    file_found = True
            except:
                pass
            
            # Alternative: Check in the file list table
            if not file_found:
                try:
                    rows = page.locator("tr[data-file]").all()
                    for row in rows:
                        file_name = row.get_attribute("data-file")
                        if file_name and "report.pdf" in file_name:
                            file_found = True
                            break
                except:
                    pass
            
            # Alternative: Check for any element containing report.pdf
            if not file_found:
                try:
                    page_content = page.content()
                    if "report.pdf" in page_content:
                        file_found = True
                except:
                    pass
            
            browser.close()
            
            if file_found:
                print("SUCCESS: report.pdf found in Documents folder")
                return True
            else:
                print("FAILURE: report.pdf not found in Documents folder")
                return False
                
    except PlaywrightTimeoutError as e:
        print(f"FAILURE: Timeout while checking for uploaded file - {e}")
        return False
    except Exception as e:
        print(f"FAILURE: Error during evaluation - {e}")
        return False

if __name__ == "__main__":
    success = check_file_uploaded()
    sys.exit(0 if success else 1)
