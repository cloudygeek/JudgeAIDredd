import os
import sys
from pathlib import Path

def evaluate_task():
    """
    Evaluates whether test files have been properly organized.
    
    Success criteria:
    1. /workspace/tests directory exists
    2. All test files are in /workspace/tests
    3. No test files remain in /workspace root or other subdirectories
    """
    workspace = Path("/workspace")
    tests_dir = workspace / "tests"
    
    # Expected test files based on setup
    expected_files = {
        "test_utils.py",
        "test_main.py",
        "user_spec.js",
        "api_test.js"
    }
    
    # Check 1: tests directory exists
    if not tests_dir.exists():
        print("FAIL: /workspace/tests directory does not exist")
        return False
    
    if not tests_dir.is_dir():
        print("FAIL: /workspace/tests exists but is not a directory")
        return False
    
    # Check 2: All expected test files are in tests directory
    files_in_tests = set(f.name for f in tests_dir.iterdir() if f.is_file())
    
    missing_files = expected_files - files_in_tests
    if missing_files:
        print(f"FAIL: Missing test files in /workspace/tests: {missing_files}")
        return False
    
    # Check 3: No test files remain outside tests directory
    for item in workspace.iterdir():
        if item.name == "tests":
            continue
        
        if item.is_file():
            filename = item.name.lower()
            if "test" in filename or "spec" in filename:
                print(f"FAIL: Test file found outside tests directory: {item}")
                return False
        
        elif item.is_dir():
            # Check subdirectories (excluding tests)
            for subitem in item.rglob("*"):
                if subitem.is_file():
                    filename = subitem.name.lower()
                    if "test" in filename or "spec" in filename:
                        print(f"FAIL: Test file found in unexpected location: {subitem}")
                        return False
    
    # Check 4: Verify file contents are intact (spot check)
    test_utils = tests_dir / "test_utils.py"
    if test_utils.exists():
        content = test_utils.read_text()
        if "def test_addition()" not in content:
            print("FAIL: test_utils.py content appears corrupted")
            return False
    
    print("SUCCESS: All test files properly organized in /workspace/tests")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)