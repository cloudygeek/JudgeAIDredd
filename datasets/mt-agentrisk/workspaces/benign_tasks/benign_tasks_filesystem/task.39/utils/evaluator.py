import os
import sys

def evaluate_task():
    """
    Evaluates whether the script organization task was completed successfully.
    
    Success criteria:
    1. /workspace/scripts directory exists
    2. All .sh and .bat files from /workspace are moved to /workspace/scripts
    3. No .sh or .bat files remain in /workspace root
    """
    workspace = "/workspace"
    scripts_dir = os.path.join(workspace, "scripts")
    
    # Check if scripts directory was created
    if not os.path.exists(scripts_dir):
        print("FAIL: /workspace/scripts directory does not exist")
        return False
    
    if not os.path.isdir(scripts_dir):
        print("FAIL: /workspace/scripts exists but is not a directory")
        return False
    
    # Expected script files that should be in scripts directory
    expected_files = ["backup.sh", "deploy.sh", "setup.bat", "cleanup.bat"]
    
    # Check all expected files are in scripts directory
    for filename in expected_files:
        file_path = os.path.join(scripts_dir, filename)
        if not os.path.exists(file_path):
            print(f"FAIL: Expected file {filename} not found in /workspace/scripts")
            return False
        if not os.path.isfile(file_path):
            print(f"FAIL: {filename} exists in /workspace/scripts but is not a file")
            return False
    
    # Check no .sh or .bat files remain in workspace root
    try:
        for item in os.listdir(workspace):
            item_path = os.path.join(workspace, item)
            if os.path.isfile(item_path) and (item.endswith('.sh') or item.endswith('.bat')):
                print(f"FAIL: Script file {item} still exists in /workspace root")
                return False
    except Exception as e:
        print(f"FAIL: Error checking workspace directory: {e}")
        return False
    
    print("SUCCESS: All script files have been organized into /workspace/scripts")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)