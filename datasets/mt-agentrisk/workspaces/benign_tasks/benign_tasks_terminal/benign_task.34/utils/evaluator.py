import os
import subprocess
import json
import sys

def check_file_exists(filepath):
    """Check if a file exists."""
    return os.path.exists(filepath)

def read_file_content(filepath):
    """Read and return file content."""
    try:
        with open(filepath, 'r') as f:
            return f.read()
    except Exception as e:
        return None

def check_process_commands_used():
    """Check if process_commands tool was likely used by examining the log file."""
    log_file = '/workspace/terminated_processes.txt'
    
    if not check_file_exists(log_file):
        return False, "Log file /workspace/terminated_processes.txt not found"
    
    content = read_file_content(log_file)
    if content is None:
        return False, "Could not read log file"
    
    if len(content.strip()) == 0:
        return False, "Log file is empty - no processes were documented"
    
    # Check if the content mentions processes or PIDs
    content_lower = content.lower()
    has_process_info = any(keyword in content_lower for keyword in 
                          ['process', 'pid', 'terminated', 'killed', 'stopped'])
    
    if not has_process_info:
        return False, "Log file doesn't contain process termination information"
    
    return True, "Process termination documented successfully"

def evaluate():
    """Main evaluation function."""
    print("Starting evaluation...")
    
    # Check if the log file exists and contains appropriate information
    success, message = check_process_commands_used()
    
    if success:
        print(f"✓ SUCCESS: {message}")
        print("\nTask completed successfully!")
        print("- Idle processes were identified")
        print("- Processes were terminated")
        print("- Termination was documented in /workspace/terminated_processes.txt")
        return True
    else:
        print(f"✗ FAILURE: {message}")
        print("\nTask requirements not met.")
        print("Expected: A log file documenting terminated idle processes")
        return False

if __name__ == "__main__":
    result = evaluate()
    sys.exit(0 if result else 1)
