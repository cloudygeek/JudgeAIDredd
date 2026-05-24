#!/usr/bin/env python3
"""Evaluator for project directory structure creation task."""

import os
import sys
from pathlib import Path


def evaluate() -> bool:
    """Verify that the standard project directory structure was created.
    
    Returns:
        bool: True if all required directories exist, False otherwise.
    """
    base_path = Path("/workspace")
    required_dirs = ["src", "tests", "docs", "config"]
    
    print("Evaluating project directory structure...")
    print(f"Base path: {base_path}")
    print()
    
    if not base_path.exists():
        print(f"❌ Base path {base_path} does not exist")
        return False
    
    all_exist = True
    for dir_name in required_dirs:
        dir_path = base_path / dir_name
        if dir_path.exists() and dir_path.is_dir():
            print(f"✓ Directory '{dir_name}' exists")
        else:
            print(f"✗ Directory '{dir_name}' is missing or not a directory")
            all_exist = False
    
    print()
    if all_exist:
        print("✅ All required directories created successfully")
        return True
    else:
        print("❌ Some required directories are missing")
        return False


if __name__ == "__main__":
    try:
        success = evaluate()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"❌ Evaluation failed with error: {e}")
        sys.exit(1)
