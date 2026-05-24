import os
import sys

def evaluate_task():
    """
    Evaluates whether the workspace structure documentation task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    structure_file_path = "/workspace/STRUCTURE.txt"
    
    # Check if STRUCTURE.txt exists
    if not os.path.exists(structure_file_path):
        print("FAIL: STRUCTURE.txt does not exist in /workspace")
        return False
    
    # Check if it's a file (not a directory)
    if not os.path.isfile(structure_file_path):
        print("FAIL: STRUCTURE.txt exists but is not a file")
        return False
    
    # Read the file contents
    try:
        with open(structure_file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read STRUCTURE.txt: {e}")
        return False
    
    # Check if file has content
    if not content or len(content.strip()) == 0:
        print("FAIL: STRUCTURE.txt is empty")
        return False
    
    # Check if content appears to be a directory structure
    # Should contain references to workspace or directory-like patterns
    content_lower = content.lower()
    
    # Look for common directory tree indicators
    has_structure_indicators = any([
        'workspace' in content_lower,
        '/' in content,
        '├' in content or '└' in content,  # Common tree characters
        '│' in content,  # Tree line character
        os.path.sep in content,  # Path separator
    ])
    
    if not has_structure_indicators:
        print("FAIL: STRUCTURE.txt does not appear to contain a directory structure")
        return False
    
    # Verify that some of the setup files are mentioned
    expected_files = ['sample.txt', 'config.json', 'README.md']
    found_files = sum(1 for f in expected_files if f in content)
    
    if found_files == 0:
        print("FAIL: STRUCTURE.txt does not contain expected workspace files")
        return False
    
    print("SUCCESS: STRUCTURE.txt created with valid directory tree content")
    print(f"File size: {len(content)} bytes")
    print(f"Found {found_files}/{len(expected_files)} expected files in structure")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)