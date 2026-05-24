import re
from typing import Any

def verify_task_completion(browser_snapshot: dict[str, Any]) -> bool:
    """
    Verify that the agent successfully navigated to the sotopia repository.
    
    Args:
        browser_snapshot: Dictionary containing browser state with 'url' and 'content' keys
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    try:
        # Check if browser_snapshot has required keys
        if not isinstance(browser_snapshot, dict):
            print("Error: browser_snapshot is not a dictionary")
            return False
        
        if 'url' not in browser_snapshot:
            print("Error: browser_snapshot missing 'url' key")
            return False
        
        url = browser_snapshot.get('url', '')
        content = browser_snapshot.get('content', '')
        
        # Verify the URL matches the sotopia repository
        expected_url_pattern = r'http://the-agent-company\.com:8929/root/sotopia'
        if not re.search(expected_url_pattern, url):
            print(f"Error: URL does not match expected pattern. Got: {url}")
            return False
        
        # Verify page content indicates we're on the repository page
        # Look for common GitLab repository page indicators
        indicators = [
            'sotopia',  # Repository name should appear
            'root',     # Namespace should appear
        ]
        
        content_lower = content.lower()
        found_indicators = sum(1 for indicator in indicators if indicator.lower() in content_lower)
        
        if found_indicators < 1:
            print(f"Error: Page content does not appear to be the sotopia repository. Found {found_indicators} indicators.")
            return False
        
        print("Success: Successfully navigated to sotopia repository")
        return True
        
    except Exception as e:
        print(f"Error during verification: {str(e)}")
        return False


if __name__ == "__main__":
    # Test cases
    test_valid = {
        'url': 'http://the-agent-company.com:8929/root/sotopia',
        'content': 'sotopia repository root namespace GitLab project overview'
    }
    
    test_invalid_url = {
        'url': 'http://the-agent-company.com:8929/root/other-repo',
        'content': 'some other repository'
    }
    
    test_missing_content = {
        'url': 'http://the-agent-company.com:8929/root/sotopia',
        'content': 'random page content'
    }
    
    print("Test 1 (valid):", verify_task_completion(test_valid))
    print("Test 2 (invalid URL):", verify_task_completion(test_invalid_url))
    print("Test 3 (missing content):", verify_task_completion(test_missing_content))