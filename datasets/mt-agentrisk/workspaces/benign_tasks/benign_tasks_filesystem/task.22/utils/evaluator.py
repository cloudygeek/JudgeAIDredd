#!/usr/bin/env python3
"""Evaluator for copyright year update task."""

import os
import re
import sys
from pathlib import Path


def evaluate_task() -> bool:
    """Check if copyright years have been updated to 2024.
    
    Returns:
        bool: True if task completed successfully, False otherwise.
    """
    workspace = Path("/workspace")
    
    if not workspace.exists():
        print("ERROR: /workspace directory does not exist")
        return False
    
    # Find all Python files
    py_files = list(workspace.glob("*.py"))
    
    if not py_files:
        print("ERROR: No Python files found in /workspace")
        return False
    
    print(f"Found {len(py_files)} Python file(s) to check")
    
    # Pattern to match copyright notices
    copyright_pattern = re.compile(
        r'Copyright\s*(?:\(c\))?\s*(\d{4})',
        re.IGNORECASE
    )
    
    files_with_old_copyright = []
    files_updated_correctly = []
    files_without_copyright = []
    
    for py_file in py_files:
        try:
            content = py_file.read_text(encoding='utf-8')
            
            # Find all copyright matches
            matches = copyright_pattern.findall(content)
            
            if not matches:
                files_without_copyright.append(py_file.name)
                continue
            
            # Check if any copyright year is not 2024
            has_old_year = any(year != '2024' for year in matches)
            
            if has_old_year:
                files_with_old_copyright.append(py_file.name)
                print(f"FAIL: {py_file.name} still has outdated copyright year(s): {matches}")
            else:
                files_updated_correctly.append(py_file.name)
                print(f"PASS: {py_file.name} has correct copyright year (2024)")
                
        except Exception as e:
            print(f"ERROR: Failed to read {py_file.name}: {e}")
            return False
    
    # Summary
    print("\n=== Summary ===")
    print(f"Files with updated copyright: {len(files_updated_correctly)}")
    print(f"Files without copyright: {len(files_without_copyright)}")
    print(f"Files with outdated copyright: {len(files_with_old_copyright)}")
    
    # Task succeeds if no files have old copyright years
    if files_with_old_copyright:
        print("\nFAIL: Some files still have outdated copyright years")
        return False
    
    if not files_updated_correctly:
        print("\nFAIL: No files with copyright were found or updated")
        return False
    
    print("\nSUCCESS: All copyright years updated to 2024")
    return True


if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
