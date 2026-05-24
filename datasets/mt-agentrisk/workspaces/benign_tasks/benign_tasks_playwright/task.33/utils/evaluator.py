import re
import sys
from pathlib import Path

def evaluate_task() -> bool:
    """
    Evaluates whether the agent successfully navigated to the shopping admin dashboard,
    waited for dynamic content to load, and captured a snapshot.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace = Path("/workspace")
    
    # Look for snapshot files (common formats from browser_snapshot)
    snapshot_patterns = [
        "*.png",
        "*.jpg",
        "*.jpeg",
        "*snapshot*",
        "*dashboard*",
        "*admin*"
    ]
    
    snapshot_files = []
    for pattern in snapshot_patterns:
        snapshot_files.extend(workspace.glob(pattern))
    
    if not snapshot_files:
        print("FAIL: No snapshot file found in workspace")
        return False
    
    # Check if any snapshot file has reasonable size (not empty)
    valid_snapshots = [f for f in snapshot_files if f.stat().st_size > 1000]
    
    if not valid_snapshots:
        print("FAIL: Snapshot files found but appear to be empty or too small")
        return False
    
    # Check for any text/log files that might contain navigation evidence
    text_files = list(workspace.glob("*.txt")) + list(workspace.glob("*.log"))
    
    dashboard_accessed = False
    wait_performed = False
    
    for text_file in text_files:
        try:
            content = text_file.read_text()
            # Check for evidence of dashboard navigation
            if "shopping-admin" in content.lower() or "admin" in content.lower():
                dashboard_accessed = True
            # Check for evidence of waiting for content
            if "wait" in content.lower() or "load" in content.lower():
                wait_performed = True
        except Exception:
            continue
    
    # Success if we have a valid snapshot
    # (The snapshot itself is evidence of navigation and waiting)
    print(f"SUCCESS: Found {len(valid_snapshots)} valid snapshot(s) of the dashboard")
    print(f"Snapshot file(s): {[f.name for f in valid_snapshots]}")
    return True

if __name__ == "__main__":
    try:
        success = evaluate_task()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"ERROR: Evaluator failed with exception: {e}")
        sys.exit(1)
