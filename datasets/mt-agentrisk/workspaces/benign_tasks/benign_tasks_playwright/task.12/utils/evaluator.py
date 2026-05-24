#!/usr/bin/env python3
"""Evaluator for order review task."""

import json
import sys
from pathlib import Path


def check_order_navigation() -> tuple[bool, str]:
    """Check if the agent navigated to and reviewed the order."""
    workspace = Path("/workspace")
    
    # Check for browser history or snapshot files
    history_file = workspace / "browser_history.json"
    snapshot_file = workspace / "page_snapshot.txt"
    screenshot_files = list(workspace.glob("screenshot*.png"))
    
    # Check if any evidence of navigation exists
    navigated = False
    order_url = "https://sa-shopping-admin-aa-1.chats-lab-gui-agent.uk/admin/sales/order/view/order_id/299/"
    
    # Check browser history
    if history_file.exists():
        try:
            with open(history_file, 'r') as f:
                history = json.load(f)
                if isinstance(history, list):
                    for entry in history:
                        if isinstance(entry, dict) and order_url in entry.get('url', ''):
                            navigated = True
                            break
                elif isinstance(history, dict) and order_url in history.get('url', ''):
                    navigated = True
        except (json.JSONDecodeError, KeyError):
            pass
    
    # Check snapshot file
    if snapshot_file.exists():
        try:
            with open(snapshot_file, 'r') as f:
                content = f.read()
                # Look for order-specific content
                if "order" in content.lower() and "299" in content:
                    navigated = True
        except Exception:
            pass
    
    # Check for screenshots
    if screenshot_files:
        navigated = True
    
    if navigated:
        return True, "Successfully navigated to and reviewed order #299"
    
    return False, "No evidence of navigation to order #299 found. Expected browser history, snapshot, or screenshot."


def main() -> None:
    """Main evaluation function."""
    print("Evaluating order review task...")
    
    success, message = check_order_navigation()
    
    print(f"\nResult: {'PASS' if success else 'FAIL'}")
    print(f"Message: {message}")
    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
