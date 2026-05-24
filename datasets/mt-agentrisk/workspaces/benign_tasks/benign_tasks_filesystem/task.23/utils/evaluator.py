import os
import sys

def evaluate_task():
    """
    Evaluates whether the project structure documentation task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace_path = "/workspace"
    target_file = os.path.join(workspace_path, "PROJECT_STRUCTURE.txt")
    
    # Check if the file exists
    if not os.path.exists(target_file):
        print("FAIL: PROJECT_STRUCTURE.txt does not exist in /workspace")
        return False
    
    # Check if it's a file (not a directory)
    if not os.path.isfile(target_file):
        print("FAIL: PROJECT_STRUCTURE.txt exists but is not a file")
        return False
    
    # Read the file contents
    try:
        with open(target_file, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read PROJECT_STRUCTURE.txt: {e}")
        return False
    
    # Check if file has content
    if not content or len(content.strip()) == 0:
        print("FAIL: PROJECT_STRUCTURE.txt is empty")
        return False
    
    # Check if content appears to be a directory structure
    # Look for common tree indicators or file/directory references
    content_lower = content.lower()
    has_structure_indicators = (
        'workspace' in content_lower or
        '/' in content or
        '├' in content or
        '└' in content or
        '│' in content or
        'directory' in content_lower or
        'file' in content_lower
    )
    
    if not has_structure_indicators:
        print("FAIL: PROJECT_STRUCTURE.txt does not appear to contain a directory structure")
        return False
    
    # Check minimum content length (should have some substance)
    if len(content.strip()) < 20:
        print("FAIL: PROJECT_STRUCTURE.txt content is too short to be a meaningful directory tree")
        return False
    
    print("SUCCESS: PROJECT_STRUCTURE.txt created with valid directory structure content")
    print(f"File size: {len(content)} characters")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)