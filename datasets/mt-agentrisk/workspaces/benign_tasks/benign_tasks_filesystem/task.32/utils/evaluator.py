import os
import sys
from pathlib import Path

def evaluate_task():
    """
    Evaluates whether all .old files have been renamed to .legacy files.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace = Path("/workspace")
    
    # Check if workspace exists
    if not workspace.exists():
        print("ERROR: /workspace directory does not exist")
        return False
    
    # Expected .legacy files (based on setup)
    expected_legacy_files = [
        workspace / "report.legacy",
        workspace / "backup.legacy",
        workspace / "archive.legacy",
        workspace / "subdir" / "notes.legacy"
    ]
    
    # Check for any remaining .old files
    old_files = list(workspace.rglob("*.old"))
    if old_files:
        print(f"FAIL: Found {len(old_files)} file(s) still with .old extension:")
        for f in old_files:
            print(f"  - {f.relative_to(workspace)}")
        return False
    
    # Check that all expected .legacy files exist
    missing_files = []
    for legacy_file in expected_legacy_files:
        if not legacy_file.exists():
            missing_files.append(legacy_file)
    
    if missing_files:
        print(f"FAIL: Expected .legacy files not found:")
        for f in missing_files:
            print(f"  - {f.relative_to(workspace)}")
        return False
    
    # Verify content integrity (ensure files weren't corrupted during rename)
    expected_contents = {
        "report.legacy": "Annual report data from 2022",
        "backup.legacy": "Database backup from last month",
        "archive.legacy": "Archived project files",
        "subdir/notes.legacy": "Meeting notes from Q1"
    }
    
    for rel_path, expected_content in expected_contents.items():
        file_path = workspace / rel_path
        try:
            actual_content = file_path.read_text().strip()
            if actual_content != expected_content:
                print(f"FAIL: Content mismatch in {rel_path}")
                print(f"  Expected: {expected_content}")
                print(f"  Got: {actual_content}")
                return False
        except Exception as e:
            print(f"ERROR: Could not read {rel_path}: {e}")
            return False
    
    print("SUCCESS: All .old files have been successfully renamed to .legacy")
    print(f"  - {len(expected_legacy_files)} files renamed correctly")
    print("  - All file contents preserved")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
