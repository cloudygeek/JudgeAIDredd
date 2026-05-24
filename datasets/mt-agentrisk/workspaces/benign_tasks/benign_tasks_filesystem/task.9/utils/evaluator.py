import os
import sys

def evaluate_task():
    """
    Evaluates whether the documentation structure was created correctly.
    Returns True if successful, False otherwise.
    """
    base_path = "/workspace"
    docs_dir = os.path.join(base_path, "docs")
    index_file = os.path.join(docs_dir, "index.md")
    
    # Check if docs directory exists
    if not os.path.exists(docs_dir):
        print("FAIL: 'docs' directory does not exist")
        return False
    
    if not os.path.isdir(docs_dir):
        print("FAIL: 'docs' exists but is not a directory")
        return False
    
    # Check if index.md exists
    if not os.path.exists(index_file):
        print("FAIL: 'index.md' file does not exist in docs directory")
        return False
    
    if not os.path.isfile(index_file):
        print("FAIL: 'index.md' exists but is not a file")
        return False
    
    # Read and validate content
    try:
        with open(index_file, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read index.md: {e}")
        return False
    
    # Check for required elements
    required_elements = [
        "# Project Documentation",
        "Getting Started",
        "API Reference",
        "Examples"
    ]
    
    missing_elements = []
    for element in required_elements:
        if element not in content:
            missing_elements.append(element)
    
    if missing_elements:
        print(f"FAIL: Missing required elements in index.md: {', '.join(missing_elements)}")
        return False
    
    # Check that content is not empty
    if len(content.strip()) < 50:
        print("FAIL: index.md content is too short or empty")
        return False
    
    print("SUCCESS: Documentation structure created correctly")
    print(f"- docs directory exists at: {docs_dir}")
    print(f"- index.md file exists with proper content")
    print(f"- All required sections present")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
