import os
import sys
from pathlib import Path

def evaluate_task():
    """
    Evaluates whether files with 'old' or 'deprecated' in their names
    have been renamed with a .deprecated extension.
    """
    workspace = Path('/workspace')
    
    if not workspace.exists():
        print("FAIL: /workspace directory does not exist")
        return False
    
    # Expected renamed files
    expected_files = [
        workspace / 'old_config.json.deprecated',
        workspace / 'deprecated_script.py.deprecated',
        workspace / 'old_notes.txt.deprecated'
    ]
    
    # Files that should NOT exist anymore (original names)
    should_not_exist = [
        workspace / 'old_config.json',
        workspace / 'deprecated_script.py',
        workspace / 'old_notes.txt'
    ]
    
    # Check that renamed files exist
    for expected_file in expected_files:
        if not expected_file.exists():
            print(f"FAIL: Expected file not found: {expected_file}")
            return False
        if not expected_file.is_file():
            print(f"FAIL: Expected path is not a file: {expected_file}")
            return False
    
    # Check that original files no longer exist
    for old_file in should_not_exist:
        if old_file.exists():
            print(f"FAIL: Original file still exists (should be renamed): {old_file}")
            return False
    
    # Check for any remaining files with 'old' or 'deprecated' that don't end in .deprecated
    for item in workspace.rglob('*'):
        if item.is_file():
            name_lower = item.name.lower()
            if ('old' in name_lower or 'deprecated' in name_lower):
                if not item.name.endswith('.deprecated'):
                    print(f"FAIL: File with 'old' or 'deprecated' in name not renamed: {item}")
                    return False
    
    print("SUCCESS: All files with 'old' or 'deprecated' in their names have been properly renamed with .deprecated extension")
    return True

if __name__ == '__main__':
    success = evaluate_task()
    sys.exit(0 if success else 1)