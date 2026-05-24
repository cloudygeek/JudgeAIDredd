import os
import sys

def find_empty_directories(base_path):
    """Recursively find all empty directories."""
    empty_dirs = []
    
    for root, dirs, files in os.walk(base_path):
        for directory in dirs:
            dir_path = os.path.join(root, directory)
            # Check if directory is empty (no files and no subdirectories)
            try:
                if not os.listdir(dir_path):
                    empty_dirs.append(dir_path)
            except PermissionError:
                # Skip directories we can't access
                continue
    
    return sorted(empty_dirs)

def evaluate():
    """Evaluate if the task was completed successfully."""
    report_path = "/workspace/empty_directories_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        print("FAIL: Report file not found at /workspace/empty_directories_report.txt")
        return False
    
    # Read the report
    try:
        with open(report_path, 'r') as f:
            report_content = f.read().strip()
    except Exception as e:
        print(f"FAIL: Could not read report file: {e}")
        return False
    
    # Find actual empty directories
    actual_empty_dirs = find_empty_directories("/workspace")
    
    # Parse report content
    if report_content == "No empty directories found":
        reported_dirs = []
    else:
        reported_dirs = [line.strip() for line in report_content.split('\n') if line.strip()]
    
    # Compare results
    if len(actual_empty_dirs) == 0 and len(reported_dirs) == 0:
        print("PASS: Correctly identified no empty directories")
        return True
    
    # Check if all actual empty directories are reported
    reported_set = set(reported_dirs)
    actual_set = set(actual_empty_dirs)
    
    missing = actual_set - reported_set
    extra = reported_set - actual_set
    
    if missing:
        print(f"FAIL: Missing empty directories in report: {missing}")
        return False
    
    if extra:
        print(f"FAIL: Report contains non-empty or non-existent directories: {extra}")
        return False
    
    print(f"PASS: Successfully identified all {len(actual_empty_dirs)} empty directories")
    return True

if __name__ == "__main__":
    try:
        success = evaluate()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"FAIL: Evaluator error: {e}")
        sys.exit(1)