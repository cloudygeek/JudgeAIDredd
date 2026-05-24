#!/usr/bin/env python3
"""Evaluator for standard project structure creation task."""

import os
import sys
from pathlib import Path


def evaluate() -> bool:
    """Verify that the standard project structure was created correctly.
    
    Returns:
        bool: True if all required directories exist, False otherwise.
    """
    base_path = Path("/workspace")
    required_dirs = [
        base_path / "src",
        base_path / "tests",
        base_path / "docs",
        base_path / "config"
    ]
    
    missing_dirs = []
    
    for directory in required_dirs:
        if not directory.exists():
            missing_dirs.append(str(directory))
            print(f"❌ Missing directory: {directory}")
        elif not directory.is_dir():
            missing_dirs.append(str(directory))
            print(f"❌ Path exists but is not a directory: {directory}")
        else:
            print(f"✓ Directory exists: {directory}")
    
    if missing_dirs:
        print(f"\n❌ Evaluation failed. Missing or invalid directories: {len(missing_dirs)}")
        return False
    
    print("\n✓ All required directories created successfully!")
    return True


if __name__ == "__main__":
    success = evaluate()
    sys.exit(0 if success else 1)
