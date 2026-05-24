import os
import sys

def evaluate_task():
    """
    Evaluates whether test files have been properly organized into /workspace/tests/
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace = "/workspace"
    tests_dir = os.path.join(workspace, "tests")
    
    # Expected test files that should be in tests directory
    expected_test_files = [
        "test_utils.py",
        "test_main.py",
        "unit_test.py",
        "integration_test.py"
    ]
    
    # Files that should remain in workspace
    expected_workspace_files = [
        "main.py",
        "utils.py",
        "config.json",
        "README.md"
    ]
    
    try:
        # Check if tests directory exists
        if not os.path.exists(tests_dir):
            print("FAIL: /workspace/tests directory does not exist")
            return False
        
        if not os.path.isdir(tests_dir):
            print("FAIL: /workspace/tests exists but is not a directory")
            return False
        
        # Check all test files are in tests directory
        tests_dir_contents = os.listdir(tests_dir)
        for test_file in expected_test_files:
            test_file_path = os.path.join(tests_dir, test_file)
            if not os.path.exists(test_file_path):
                print(f"FAIL: Test file {test_file} not found in /workspace/tests/")
                return False
            if not os.path.isfile(test_file_path):
                print(f"FAIL: {test_file} in tests directory is not a file")
                return False
        
        # Check test files are NOT in workspace root
        workspace_contents = os.listdir(workspace)
        for test_file in expected_test_files:
            root_test_path = os.path.join(workspace, test_file)
            if os.path.exists(root_test_path):
                print(f"FAIL: Test file {test_file} still exists in /workspace/ root")
                return False
        
        # Check non-test files remain in workspace
        for regular_file in expected_workspace_files:
            regular_file_path = os.path.join(workspace, regular_file)
            if not os.path.exists(regular_file_path):
                print(f"FAIL: Non-test file {regular_file} missing from /workspace/")
                return False
            if not os.path.isfile(regular_file_path):
                print(f"FAIL: {regular_file} in workspace is not a file")
                return False
        
        print("SUCCESS: All test files properly organized in /workspace/tests/")
        return True
        
    except Exception as e:
        print(f"ERROR during evaluation: {str(e)}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)