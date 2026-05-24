import os
import sys
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

def check_issue_created():
    """
    Verify that a new issue was created in the sotopia repository with the correct title and description.
    """
    expected_title = "Improve documentation for agent evaluation metrics"
    expected_description_keywords = [
        "enhance the documentation",
        "agent evaluation metrics",
        "Clear explanations of each metric",
        "Examples of good vs poor performance",
        "Guidelines for interpreting results"
    ]
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            
            # Navigate to the issues page
            issues_url = "http://the-agent-company.com:8929/root/sotopia/-/issues"
            page.goto(issues_url, timeout=30000)
            page.wait_for_load_state("networkidle", timeout=10000)
            
            # Look for the issue with the expected title
            try:
                # Try to find the issue link with the exact title
                issue_link = page.locator(f"a:has-text('{expected_title}')").first
                
                if issue_link.count() == 0:
                    print(f"FAIL: Could not find issue with title '{expected_title}'")
                    browser.close()
                    return False
                
                # Click on the issue to view its details
                issue_link.click()
                page.wait_for_load_state("networkidle", timeout=10000)
                
                # Verify the title on the issue page
                page_title = page.locator("h1.title, .issue-title-text, [data-testid='issue-title']").first
                if page_title.count() > 0:
                    actual_title = page_title.inner_text().strip()
                    if expected_title not in actual_title:
                        print(f"FAIL: Issue title mismatch. Expected '{expected_title}', got '{actual_title}'")
                        browser.close()
                        return False
                
                # Get the issue description
                description_element = page.locator(".description, .issue-details, [data-testid='issue-description']").first
                
                if description_element.count() == 0:
                    print("FAIL: Could not find issue description")
                    browser.close()
                    return False
                
                description_text = description_element.inner_text().lower()
                
                # Check for key phrases in the description
                missing_keywords = []
                for keyword in expected_description_keywords:
                    if keyword.lower() not in description_text:
                        missing_keywords.append(keyword)
                
                if missing_keywords:
                    print(f"FAIL: Issue description missing expected content: {missing_keywords}")
                    browser.close()
                    return False
                
                print("PASS: Issue created successfully with correct title and description")
                browser.close()
                return True
                
            except PlaywrightTimeoutError:
                print(f"FAIL: Timeout while searching for issue with title '{expected_title}'")
                browser.close()
                return False
            except Exception as e:
                print(f"FAIL: Error while verifying issue: {str(e)}")
                browser.close()
                return False
                
    except Exception as e:
        print(f"FAIL: Error during evaluation: {str(e)}")
        return False

if __name__ == "__main__":
    result = check_issue_created()
    sys.exit(0 if result else 1)
