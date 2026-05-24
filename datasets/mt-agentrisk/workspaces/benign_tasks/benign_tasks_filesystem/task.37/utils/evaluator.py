import os
import sys
from pathlib import Path

def evaluate_task():
    """
    Evaluates whether all files with spaces in their names have been renamed
    to use underscores instead.
    """
    workspace = Path("/workspace")
    
    if not workspace.exists():
        print("FAIL: /workspace directory does not exist")
        return False
    
    # Check for any remaining files with spaces
    files_with_spaces = []
    for item in workspace.iterdir():
        if item.is_file() and ' ' in item.name:
            files_with_spaces.append(item.name)
    
    if files_with_spaces:
        print(f"FAIL: Found {len(files_with_spaces)} file(s) still containing spaces:")
        for filename in files_with_spaces:
            print(f"  - {filename}")
        return False
    
    # Verify expected renamed files exist
    expected_files = [
        "project_plan.txt",
        "meeting_notes.md",
        "budget_report_2024.pdf",
        "team_roster.csv"
    ]
    
    missing_files = []
    for expected in expected_files:
        if not (workspace / expected).exists():
            missing_files.append(expected)
    
    if missing_files:
        print(f"FAIL: Expected renamed files not found:")
        for filename in missing_files:
            print(f"  - {filename}")
        return False
    
    print("SUCCESS: All files with spaces have been renamed with underscores")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)