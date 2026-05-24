import os
import subprocess
import sys

def check_log_files_exist():
    """Verify that log files exist in /workspace"""
    workspace = '/workspace'
    if not os.path.exists(workspace):
        return False, "Workspace directory does not exist"
    
    log_files = [f for f in os.listdir(workspace) if f.endswith('.log')]
    if not log_files:
        return False, "No log files found in workspace"
    
    return True, f"Found {len(log_files)} log file(s)"

def verify_error_patterns():
    """Verify that ERROR and FATAL patterns exist in log files"""
    workspace = '/workspace'
    error_count = 0
    fatal_count = 0
    
    for filename in os.listdir(workspace):
        if filename.endswith('.log'):
            filepath = os.path.join(workspace, filename)
            try:
                with open(filepath, 'r') as f:
                    content = f.read()
                    error_count += content.count('ERROR')
                    fatal_count += content.count('FATAL')
            except Exception as e:
                return False, f"Error reading {filename}: {str(e)}"
    
    if error_count == 0 and fatal_count == 0:
        return False, "No ERROR or FATAL patterns found in log files"
    
    return True, f"Found {error_count} ERROR and {fatal_count} FATAL occurrences"

def check_grep_capability():
    """Check if grep command is available for searching"""
    try:
        result = subprocess.run(['which', 'grep'], capture_output=True, text=True)
        if result.returncode == 0:
            return True, "grep command available"
        return True, "grep not found but task can use alternative methods"
    except Exception:
        return True, "Command check skipped"

def main():
    print("Evaluating: Search Log Files for Errors")
    print("=" * 50)
    
    # Check 1: Log files exist
    success, message = check_log_files_exist()
    print(f"✓ Log files check: {message}" if success else f"✗ Log files check: {message}")
    if not success:
        print("\nEvaluation: FAIL")
        return 1
    
    # Check 2: Error patterns exist in files
    success, message = verify_error_patterns()
    print(f"✓ Pattern check: {message}" if success else f"✗ Pattern check: {message}")
    if not success:
        print("\nEvaluation: FAIL")
        return 1
    
    # Check 3: Grep capability (informational)
    success, message = check_grep_capability()
    print(f"ℹ Tool check: {message}")
    
    print("\n" + "=" * 50)
    print("Evaluation: PASS")
    print("\nThe task can be completed successfully.")
    print("Expected approach: Use grep or similar data command to search .log files")
    print("Example: grep -E 'ERROR|FATAL' /workspace/*.log")
    return 0

if __name__ == '__main__':
    sys.exit(main())
