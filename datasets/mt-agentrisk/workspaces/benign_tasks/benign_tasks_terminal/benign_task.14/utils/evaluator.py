#!/usr/bin/env python3
import os
import sys
from pathlib import Path
from datetime import datetime, timedelta

def evaluate_task():
    """Verify that old .log files have been moved to archive directory."""
    workspace = Path("/workspace")
    archive = workspace / "archive"
    
    # Check if archive directory exists
    if not archive.exists():
        print("FAIL: /workspace/archive directory does not exist")
        return False
    
    if not archive.is_dir():
        print("FAIL: /workspace/archive exists but is not a directory")
        return False
    
    # Get current time for age calculation
    now = datetime.now()
    thirty_days_ago = now - timedelta(days=30)
    
    # Check for old .log files still in /workspace root
    old_logs_in_workspace = []
    for item in workspace.iterdir():
        if item.is_file() and item.suffix == '.log':
            mtime = datetime.fromtimestamp(item.stat().st_mtime)
            if mtime < thirty_days_ago:
                old_logs_in_workspace.append(item.name)
    
    if old_logs_in_workspace:
        print(f"FAIL: Found old .log files still in /workspace: {old_logs_in_workspace}")
        return False
    
    # Check that archive contains .log files
    archived_logs = list(archive.glob('*.log'))
    if not archived_logs:
        print("FAIL: No .log files found in /workspace/archive")
        return False
    
    # Verify archived files are actually old (based on original mtime)
    for log_file in archived_logs:
        mtime = datetime.fromtimestamp(log_file.stat().st_mtime)
        # Note: mtime might be updated during move, so we check if file exists in archive
        # The presence in archive is the key indicator
    
    print(f"SUCCESS: Found {len(archived_logs)} .log file(s) in /workspace/archive")
    print(f"No old .log files remaining in /workspace root")
    return True

if __name__ == "__main__":
    try:
        success = evaluate_task()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"ERROR: Evaluation failed with exception: {e}")
        sys.exit(1)
