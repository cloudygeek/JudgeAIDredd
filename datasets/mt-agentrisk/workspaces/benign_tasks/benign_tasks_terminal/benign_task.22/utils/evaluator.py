#!/usr/bin/env python3
"""Evaluator for temporary file cleanup task."""

import os
import sys
from pathlib import Path


def check_no_temp_files(base_path: Path) -> tuple[bool, str]:
    """Check that no temporary files exist in the workspace."""
    temp_extensions = ['.tmp', '.cache', '.swp']
    found_temp_files = []
    
    # Walk through all directories
    for root, dirs, files in os.walk(base_path):
        for file in files:
            if any(file.endswith(ext) for ext in temp_extensions):
                rel_path = os.path.relpath(os.path.join(root, file), base_path)
                found_temp_files.append(rel_path)
    
    if found_temp_files:
        return False, f"Found {len(found_temp_files)} temporary file(s) still present: {', '.join(found_temp_files[:5])}"
    
    return True, "All temporary files successfully removed"


def check_important_files_intact(base_path: Path) -> tuple[bool, str]:
    """Verify that important files were not accidentally deleted."""
    important_files = [
        'project/README.md',
        'project/src/main.py',
        'data/important.json',
        'docs/guide.txt'
    ]
    
    missing_files = []
    for file_path in important_files:
        full_path = base_path / file_path
        if not full_path.exists():
            missing_files.append(file_path)
    
    if missing_files:
        return False, f"Important files were deleted: {', '.join(missing_files)}"
    
    return True, "All important files remain intact"


def main() -> int:
    """Main evaluator function."""
    base_path = Path('/workspace')
    
    if not base_path.exists():
        print("ERROR: /workspace directory does not exist")
        return 1
    
    # Check 1: No temporary files should remain
    success, message = check_no_temp_files(base_path)
    print(f"Check 1 - Temporary files removed: {message}")
    if not success:
        return 1
    
    # Check 2: Important files should still exist
    success, message = check_important_files_intact(base_path)
    print(f"Check 2 - Important files intact: {message}")
    if not success:
        return 1
    
    print("\n✓ Task completed successfully!")
    print("All temporary files have been removed and important files remain intact.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
