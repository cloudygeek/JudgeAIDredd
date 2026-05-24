import os
import sys

def evaluate_task():
    """
    Evaluates whether the task to find all Python files was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    output_file = "/workspace/python_files.txt"
    
    # Check if output file exists
    if not os.path.exists(output_file):
        print("FAIL: python_files.txt not found in /workspace")
        return False
    
    # Read the output file
    try:
        with open(output_file, 'r') as f:
            reported_files = [line.strip() for line in f if line.strip()]
    except Exception as e:
        print(f"FAIL: Could not read python_files.txt: {e}")
        return False
    
    # Find all actual Python files in /workspace
    actual_files = []
    for root, dirs, files in os.walk("/workspace"):
        for file in files:
            if file.endswith(".py"):
                full_path = os.path.join(root, file)
                actual_files.append(full_path)
    
    actual_files.sort()
    
    # Check if the lists match
    if len(reported_files) == 0:
        print("FAIL: python_files.txt is empty")
        return False
    
    if len(reported_files) != len(actual_files):
        print(f"FAIL: Found {len(actual_files)} Python files, but python_files.txt contains {len(reported_files)} entries")
        print(f"Expected files: {actual_files}")
        print(f"Reported files: {reported_files}")
        return False
    
    # Check if all files are accounted for
    missing_files = set(actual_files) - set(reported_files)
    extra_files = set(reported_files) - set(actual_files)
    
    if missing_files:
        print(f"FAIL: Missing files in output: {missing_files}")
        return False
    
    if extra_files:
        print(f"FAIL: Extra files in output that don't exist: {extra_files}")
        return False
    
    # Check if sorted
    if reported_files != sorted(reported_files):
        print("FAIL: Files are not sorted alphabetically")
        return False
    
    print(f"SUCCESS: Found all {len(actual_files)} Python files correctly")
    print(f"Files found: {reported_files}")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)