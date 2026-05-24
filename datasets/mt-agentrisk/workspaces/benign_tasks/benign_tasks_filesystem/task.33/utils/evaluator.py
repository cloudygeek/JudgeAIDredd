import os
import sys

def evaluate_task():
    """
    Evaluates whether the workspace access documentation task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace_path = "/workspace"
    target_file = os.path.join(workspace_path, "WORKSPACE_ACCESS.txt")
    
    # Check if the file exists
    if not os.path.exists(target_file):
        print("FAIL: WORKSPACE_ACCESS.txt does not exist in /workspace")
        return False
    
    # Read the file contents
    try:
        with open(target_file, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read WORKSPACE_ACCESS.txt: {e}")
        return False
    
    # Check if file is empty
    if not content.strip():
        print("FAIL: WORKSPACE_ACCESS.txt is empty")
        return False
    
    # Check for header
    if "Accessible Directories:" not in content:
        print("FAIL: Missing 'Accessible Directories:' header")
        return False
    
    # Check if it contains at least one directory path
    lines = content.strip().split('\n')
    # Filter out empty lines and the header
    directory_lines = [line.strip() for line in lines if line.strip() and "Accessible Directories:" not in line]
    
    if len(directory_lines) == 0:
        print("FAIL: No directory paths listed in the file")
        return False
    
    # Check if at least one line looks like a path (contains /workspace)
    has_valid_path = any("/workspace" in line for line in directory_lines)
    
    if not has_valid_path:
        print("FAIL: No valid directory paths found (should contain /workspace)")
        return False
    
    print("SUCCESS: WORKSPACE_ACCESS.txt correctly documents accessible directories")
    print(f"Found {len(directory_lines)} directory path(s) listed")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)