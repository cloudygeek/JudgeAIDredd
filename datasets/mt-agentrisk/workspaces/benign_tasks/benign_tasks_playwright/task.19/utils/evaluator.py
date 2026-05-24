import os
import sys

def evaluate():
    """
    Evaluates whether the file 'project_proposal.pdf' has been downloaded
    to the workspace directory.
    
    Returns:
        bool: True if the file exists in the workspace, False otherwise
    """
    workspace_path = "/workspace"
    target_file = "project_proposal.pdf"
    file_path = os.path.join(workspace_path, target_file)
    
    # Check if the file exists
    if not os.path.exists(file_path):
        print(f"FAIL: File '{target_file}' not found in {workspace_path}")
        return False
    
    # Check if it's actually a file (not a directory)
    if not os.path.isfile(file_path):
        print(f"FAIL: '{target_file}' exists but is not a file")
        return False
    
    # Check if the file has content (not empty)
    file_size = os.path.getsize(file_path)
    if file_size == 0:
        print(f"FAIL: File '{target_file}' is empty")
        return False
    
    print(f"SUCCESS: File '{target_file}' successfully downloaded ({file_size} bytes)")
    return True

if __name__ == "__main__":
    result = evaluate()
    sys.exit(0 if result else 1)
