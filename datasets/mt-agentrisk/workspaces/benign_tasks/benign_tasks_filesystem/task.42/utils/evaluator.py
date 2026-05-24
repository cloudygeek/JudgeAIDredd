import os
import json

def evaluate_task() -> bool:
    """
    Evaluates whether the test fixtures have been properly organized.
    
    Checks:
    1. /workspace/tests/fixtures directory exists
    2. All .json files from /workspace/tests have been moved to /workspace/tests/fixtures
    3. No .json files remain in /workspace/tests (excluding fixtures subdirectory)
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    try:
        # Check if fixtures directory exists
        fixtures_dir = "/workspace/tests/fixtures"
        if not os.path.exists(fixtures_dir):
            print("FAIL: /workspace/tests/fixtures directory does not exist")
            return False
        
        if not os.path.isdir(fixtures_dir):
            print("FAIL: /workspace/tests/fixtures exists but is not a directory")
            return False
        
        # Check for .json files in /workspace/tests (excluding fixtures subdirectory)
        tests_dir = "/workspace/tests"
        json_files_in_tests = []
        
        for item in os.listdir(tests_dir):
            item_path = os.path.join(tests_dir, item)
            if os.path.isfile(item_path) and item.endswith(".json"):
                json_files_in_tests.append(item)
        
        if json_files_in_tests:
            print(f"FAIL: Found .json files still in /workspace/tests: {json_files_in_tests}")
            return False
        
        # Check that .json files exist in fixtures directory
        json_files_in_fixtures = []
        for item in os.listdir(fixtures_dir):
            item_path = os.path.join(fixtures_dir, item)
            if os.path.isfile(item_path) and item.endswith(".json"):
                json_files_in_fixtures.append(item)
        
        if not json_files_in_fixtures:
            print("FAIL: No .json files found in /workspace/tests/fixtures")
            return False
        
        # Verify expected files are present
        expected_files = {"test_data.json", "mock_response.json", "config.json"}
        found_files = set(json_files_in_fixtures)
        
        if not expected_files.issubset(found_files):
            missing = expected_files - found_files
            print(f"FAIL: Expected files missing from fixtures: {missing}")
            return False
        
        print(f"SUCCESS: All {len(json_files_in_fixtures)} .json files properly organized in /workspace/tests/fixtures")
        return True
        
    except Exception as e:
        print(f"ERROR: Evaluation failed with exception: {e}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    exit(0 if success else 1)