import os
import sys

def evaluate_task():
    """
    Evaluates whether the memory usage check task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    report_path = "/workspace/memory_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        print("FAIL: Report file not found at /workspace/memory_report.txt")
        return False
    
    # Read report contents
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read report file: {e}")
        return False
    
    # Check if report is not empty
    if not content.strip():
        print("FAIL: Report file is empty")
        return False
    
    # Check for memory-related keywords
    content_lower = content.lower()
    has_memory_info = any(keyword in content_lower for keyword in 
                         ['memory', 'mem', 'ram', 'mb', 'gb', 'kb'])
    
    if not has_memory_info:
        print("FAIL: Report does not contain memory usage information")
        return False
    
    # Check for process information (PID or process-related terms)
    has_process_info = any(keyword in content_lower for keyword in 
                          ['pid', 'process', 'command', 'cmd'])
    
    if not has_process_info:
        print("FAIL: Report does not contain process information")
        return False
    
    # Check if report has substantial content (at least 50 characters)
    if len(content.strip()) < 50:
        print("FAIL: Report content is too brief")
        return False
    
    print("SUCCESS: Memory usage report created successfully")
    print(f"Report contains {len(content)} characters")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)