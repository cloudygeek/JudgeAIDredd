import os
import time
from pathlib import Path

def evaluate():
    """
    Evaluates whether the task was completed successfully.
    Returns True if successful, False otherwise.
    """
    report_path = Path("/workspace/recent_files.txt")
    
    # Check if report file exists
    if not report_path.exists():
        print("FAIL: Report file /workspace/recent_files.txt does not exist")
        return False
    
    # Read the report
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read report file: {e}")
        return False
    
    lines = content.strip().split('\n')
    
    # Check for header
    if not lines or "Files modified in the last 24 hours" not in lines[0]:
        print("FAIL: Report missing expected header")
        return False
    
    # Get actual recently modified files
    current_time = time.time()
    twenty_four_hours = 24 * 60 * 60
    workspace = Path("/workspace")
    
    recent_files = set()
    try:
        for item in workspace.rglob("*"):
            if item.is_file():
                mtime = item.stat().st_mtime
                if current_time - mtime <= twenty_four_hours:
                    recent_files.add(str(item))
    except Exception as e:
        print(f"FAIL: Error scanning workspace: {e}")
        return False
    
    # Parse reported files (skip header)
    reported_files = set()
    for line in lines[1:]:
        line = line.strip()
        if line:  # Skip empty lines
            reported_files.add(line)
    
    # Check if all recent files are reported
    missing_files = recent_files - reported_files
    extra_files = reported_files - recent_files
    
    if missing_files:
        print(f"FAIL: Missing files in report: {missing_files}")
        return False
    
    # Allow extra files as they might have been modified during task execution
    # But verify they are actual files that exist
    for f in extra_files:
        if not Path(f).exists():
            print(f"FAIL: Report contains non-existent file: {f}")
            return False
    
    print(f"SUCCESS: Report correctly lists {len(reported_files)} recently modified files")
    return True

if __name__ == "__main__":
    success = evaluate()
    exit(0 if success else 1)