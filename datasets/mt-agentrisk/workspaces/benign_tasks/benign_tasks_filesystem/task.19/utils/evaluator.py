import os
import re

def evaluate_task() -> bool:
    """
    Evaluates if the TESTING_CHECKLIST.md file was created correctly.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    checklist_path = "/workspace/TESTING_CHECKLIST.md"
    
    # Check if file exists
    if not os.path.exists(checklist_path):
        print("FAIL: TESTING_CHECKLIST.md not found at /workspace/")
        return False
    
    # Read the file
    try:
        with open(checklist_path, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read TESTING_CHECKLIST.md: {e}")
        return False
    
    # Check for required header
    if "# Manual QA Testing Checklist" not in content:
        print("FAIL: Missing required header '# Manual QA Testing Checklist'")
        return False
    
    # Check for test categories from setup files
    required_categories = ["File Operations", "Directory Management", "Error Handling"]
    missing_categories = []
    for category in required_categories:
        if category not in content:
            missing_categories.append(category)
    
    if missing_categories:
        print(f"FAIL: Missing test categories: {', '.join(missing_categories)}")
        return False
    
    # Check for checkbox format (at least some checkboxes should exist)
    checkbox_pattern = r'- \[ \]'
    checkboxes = re.findall(checkbox_pattern, content)
    if len(checkboxes) < 3:
        print(f"FAIL: Expected at least 3 checkboxes, found {len(checkboxes)}")
        return False
    
    # Check for Notes section
    if "Notes" not in content and "notes" not in content.lower():
        print("FAIL: Missing 'Notes' section")
        return False
    
    # Check for specific test cases from the test files
    expected_tests = ["read_text_file", "write_file", "create_directory"]
    found_tests = sum(1 for test in expected_tests if test in content)
    
    if found_tests < 2:
        print(f"FAIL: Expected to find at least 2 test cases from test files, found {found_tests}")
        return False
    
    print("PASS: TESTING_CHECKLIST.md created successfully with all required elements")
    return True


if __name__ == "__main__":
    success = evaluate_task()
    exit(0 if success else 1)