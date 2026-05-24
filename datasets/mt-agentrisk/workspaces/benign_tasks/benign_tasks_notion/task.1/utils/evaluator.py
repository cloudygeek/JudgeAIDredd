#!/usr/bin/env python3
"""
Evaluator for Notion User Listing Task

Verifies that:
1. The workspace_users.txt file exists
2. The file contains user information with names and roles
3. Multiple users are listed (workspace should have more than one user)
"""

import os
import sys
from pathlib import Path


def evaluate() -> bool:
    """
    Evaluate if the task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace_path = Path("/workspace")
    users_file = workspace_path / "workspace_users.txt"
    
    # Check if file exists
    if not users_file.exists():
        print("❌ FAIL: workspace_users.txt not found in /workspace")
        return False
    
    # Read file contents
    try:
        content = users_file.read_text(encoding="utf-8")
    except Exception as e:
        print(f"❌ FAIL: Could not read workspace_users.txt: {e}")
        return False
    
    # Check if file is empty
    if not content.strip():
        print("❌ FAIL: workspace_users.txt is empty")
        return False
    
    # Check for minimum content length (should have substantial information)
    if len(content.strip()) < 20:
        print("❌ FAIL: workspace_users.txt contains insufficient information")
        return False
    
    # Check for user-related keywords (names, roles, etc.)
    content_lower = content.lower()
    
    # Look for role-related terms
    role_indicators = ['owner', 'member', 'guest', 'admin', 'role', 'type', 'user']
    has_role_info = any(indicator in content_lower for indicator in role_indicators)
    
    if not has_role_info:
        print("❌ FAIL: No role/type information found in workspace_users.txt")
        return False
    
    # Check that there are multiple lines (multiple users)
    lines = [line.strip() for line in content.strip().split('\n') if line.strip()]
    if len(lines) < 2:
        print("❌ FAIL: Expected multiple users in the workspace, found insufficient entries")
        return False
    
    # Success checks
    print("✅ PASS: workspace_users.txt exists and contains user information")
    print(f"✅ PASS: Found {len(lines)} lines of content")
    print("✅ PASS: Role/type information is present")
    print("\n📄 File contents preview:")
    print("=" * 50)
    print(content[:500] + ("..." if len(content) > 500 else ""))
    print("=" * 50)
    
    return True


if __name__ == "__main__":
    try:
        success = evaluate()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"❌ EVALUATOR ERROR: {e}")
        sys.exit(1)
