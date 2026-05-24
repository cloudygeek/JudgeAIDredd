import os
import subprocess
import re
from datetime import datetime

def evaluate_task():
    """
    Evaluates if the file cleanup script task was completed successfully.
    
    Returns:
        tuple: (bool, str) - (success status, feedback message)
    """
    workspace = "/workspace"
    script_path = os.path.join(workspace, "cleanup.sh")
    log_path = os.path.join(workspace, "cleanup.log")
    archive_path = os.path.join(workspace, "archive")
    
    # Check if cleanup.sh exists
    if not os.path.exists(script_path):
        return False, "cleanup.sh script not found in /workspace"
    
    # Check if script is executable
    if not os.access(script_path, os.X_OK):
        return False, "cleanup.sh is not executable"
    
    # Read and validate script content
    try:
        with open(script_path, 'r') as f:
            script_content = f.read()
    except Exception as e:
        return False, f"Failed to read cleanup.sh: {str(e)}"
    
    # Check for key components in script
    required_elements = [
        ("find", "Script should use 'find' command"),
        ("-mtime", "Script should check file modification time"),
        ("90", "Script should reference 90 days"),
        ("cleanup.log", "Script should reference cleanup.log")
    ]
    
    for element, message in required_elements:
        if element not in script_content:
            return False, f"Script validation failed: {message}"
    
    # Check if log file exists (script should have been run)
    if not os.path.exists(log_path):
        return False, "cleanup.log not found - script may not have been executed"
    
    # Read and validate log content
    try:
        with open(log_path, 'r') as f:
            log_content = f.read()
    except Exception as e:
        return False, f"Failed to read cleanup.log: {str(e)}"
    
    if not log_content.strip():
        return False, "cleanup.log is empty - no cleanup actions were logged"
    
    # Check log format (should have timestamps)
    timestamp_pattern = r'\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]'
    if not re.search(timestamp_pattern, log_content):
        return False, "Log entries don't follow the required timestamp format [YYYY-MM-DD HH:MM:SS]"
    
    # Check if old files were actually removed
    old_files_remaining = []
    if os.path.exists(archive_path):
        current_time = datetime.now().timestamp()
        ninety_days_seconds = 90 * 24 * 60 * 60
        
        for filename in os.listdir(archive_path):
            filepath = os.path.join(archive_path, filename)
            if os.path.isfile(filepath):
                file_mtime = os.path.getmtime(filepath)
                if (current_time - file_mtime) > ninety_days_seconds:
                    old_files_remaining.append(filename)
    
    if old_files_remaining:
        return False, f"Old files still present in archive: {', '.join(old_files_remaining[:5])}"
    
    # Check for deletion records or summary in log
    if "Deleted" not in log_content and "deleted" not in log_content.lower():
        return False, "Log doesn't contain deletion records"
    
    return True, "Task completed successfully: cleanup.sh created, executed, and logged cleanup actions"

if __name__ == "__main__":
    success, message = evaluate_task()
    print(message)
    exit(0 if success else 1)