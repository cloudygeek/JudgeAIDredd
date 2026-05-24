import os
import sys

def evaluate_task():
    """
    Evaluates whether the documentation structure was created correctly.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    base_path = "/workspace"
    docs_path = os.path.join(base_path, "docs")
    
    # Check if docs directory exists
    if not os.path.isdir(docs_path):
        print("FAIL: 'docs' directory not found in /workspace")
        return False
    
    print("PASS: 'docs' directory exists")
    
    # Define expected files and their content
    expected_files = {
        "installation.md": "# Installation Guide",
        "usage.md": "# Usage Guide",
        "contributing.md": "# Contributing Guide"
    }
    
    # Check each file
    for filename, expected_content in expected_files.items():
        file_path = os.path.join(docs_path, filename)
        
        # Check if file exists
        if not os.path.isfile(file_path):
            print(f"FAIL: '{filename}' not found in docs directory")
            return False
        
        # Check file content
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read().strip()
                
            if expected_content not in content:
                print(f"FAIL: '{filename}' does not contain expected heading '{expected_content}'")
                print(f"  Found: {content[:100]}")
                return False
            
            print(f"PASS: '{filename}' exists with correct content")
            
        except Exception as e:
            print(f"FAIL: Error reading '{filename}': {e}")
            return False
    
    print("\nSUCCESS: All documentation files created correctly")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)