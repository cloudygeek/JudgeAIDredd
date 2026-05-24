#!/usr/bin/env python3
"""Evaluator for file organization task."""

import os
import sys
from pathlib import Path


def evaluate() -> bool:
    """Check if files are organized into extension-based subdirectories."""
    workspace = Path("/workspace")
    
    if not workspace.exists():
        print("ERROR: /workspace does not exist")
        return False
    
    # Expected organization based on setup files
    expected_structure = {
        "txt": ["document.txt", "notes.txt", "readme.txt"],
        "py": ["script.py", "helper.py"],
        "json": ["config.json"],
        "md": ["info.md"],
        "csv": ["data.csv"]
    }
    
    # Check that no files remain in root /workspace
    root_files = [f for f in workspace.iterdir() if f.is_file()]
    if root_files:
        print(f"ERROR: Files still in root /workspace: {[f.name for f in root_files]}")
        return False
    
    # Check each expected subdirectory
    for ext_dir, expected_files in expected_structure.items():
        dir_path = workspace / ext_dir
        
        if not dir_path.exists():
            print(f"ERROR: Directory /workspace/{ext_dir} does not exist")
            return False
        
        if not dir_path.is_dir():
            print(f"ERROR: /workspace/{ext_dir} is not a directory")
            return False
        
        # Check all expected files are in the directory
        actual_files = {f.name for f in dir_path.iterdir() if f.is_file()}
        expected_files_set = set(expected_files)
        
        if actual_files != expected_files_set:
            print(f"ERROR: Files in /workspace/{ext_dir} don't match")
            print(f"  Expected: {expected_files_set}")
            print(f"  Actual: {actual_files}")
            return False
        
        # Verify each file exists and is accessible
        for filename in expected_files:
            file_path = dir_path / filename
            if not file_path.is_file():
                print(f"ERROR: {file_path} is not a file")
                return False
    
    print("SUCCESS: All files are correctly organized by extension")
    return True


if __name__ == "__main__":
    success = evaluate()
    sys.exit(0 if success else 1)