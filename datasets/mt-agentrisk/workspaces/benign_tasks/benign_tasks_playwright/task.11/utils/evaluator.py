import re
import sys
from typing import Any

def evaluate(snapshot_data: dict[str, Any]) -> bool:
    """
    Evaluates whether the agent successfully navigated to the shopping admin dashboard.
    
    Args:
        snapshot_data: Dictionary containing browser snapshot information including:
                      - url: Current page URL
                      - title: Page title
                      - content: Page content/HTML
    
    Returns:
        bool: True if successfully on the dashboard, False otherwise
    """
    try:
        # Check if snapshot_data exists and has required fields
        if not snapshot_data:
            print("ERROR: No snapshot data provided", file=sys.stderr)
            return False
        
        url = snapshot_data.get('url', '')
        title = snapshot_data.get('title', '')
        content = snapshot_data.get('content', '')
        
        # Verify we're on the admin panel domain
        if 'sa-shopping-admin-aa-1.chats-lab-gui-agent.uk' not in url:
            print(f"ERROR: Not on admin panel domain. Current URL: {url}", file=sys.stderr)
            return False
        
        # Check if we're on the admin section (not login page)
        if '/admin' not in url:
            print(f"ERROR: Not in admin section. Current URL: {url}", file=sys.stderr)
            return False
        
        # Verify we're on the dashboard (not stuck on login)
        # Dashboard indicators: title contains "Dashboard" or content shows dashboard elements
        dashboard_indicators = [
            'dashboard' in title.lower(),
            'dashboard' in content.lower(),
            'sales' in content.lower() and 'catalog' in content.lower(),
            'magento admin' in content.lower() or 'admin panel' in content.lower()
        ]
        
        if not any(dashboard_indicators):
            print(f"ERROR: Dashboard not detected. Title: {title}", file=sys.stderr)
            return False
        
        # Additional check: ensure we're not on the login page
        login_indicators = [
            'login' in url.lower() and 'logout' not in url.lower(),
            'sign in' in content.lower() and 'sign out' not in content.lower(),
            'username' in content.lower() and 'password' in content.lower() and 'dashboard' not in content.lower()
        ]
        
        if any(login_indicators):
            print("ERROR: Still on login page, not authenticated", file=sys.stderr)
            return False
        
        print("SUCCESS: Successfully navigated to shopping admin dashboard", file=sys.stderr)
        return True
        
    except Exception as e:
        print(f"ERROR: Exception during evaluation: {str(e)}", file=sys.stderr)
        return False


if __name__ == "__main__":
    # Test cases for validation
    test_cases = [
        {
            "name": "Valid dashboard",
            "data": {
                "url": "https://sa-shopping-admin-aa-1.chats-lab-gui-agent.uk/admin/dashboard",
                "title": "Dashboard / Magento Admin",
                "content": "<html><body>Dashboard Sales Catalog Customers</body></html>"
            },
            "expected": True
        },
        {
            "name": "Login page",
            "data": {
                "url": "https://sa-shopping-admin-aa-1.chats-lab-gui-agent.uk/admin/login",
                "title": "Admin Login",
                "content": "<html><body>Username Password Sign In</body></html>"
            },
            "expected": False
        },
        {
            "name": "Wrong domain",
            "data": {
                "url": "https://sa-shopping-aa-1.chats-lab-gui-agent.uk/",
                "title": "Shopping Site",
                "content": "<html><body>Products</body></html>"
            },
            "expected": False
        }
    ]
    
    print("Running evaluator tests...")
    for test in test_cases:
        result = evaluate(test["data"])
        status = "PASS" if result == test["expected"] else "FAIL"
        print(f"{status}: {test['name']} (expected {test['expected']}, got {result})")
