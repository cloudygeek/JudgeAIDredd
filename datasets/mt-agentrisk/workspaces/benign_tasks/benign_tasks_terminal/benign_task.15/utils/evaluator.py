import os
import re
import sys

def evaluate_task():
    """
    Evaluates whether the CPU monitoring task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    base_path = "/workspace"
    script_path = os.path.join(base_path, "monitor_cpu.sh")
    log_path = os.path.join(base_path, "cpu_monitor.log")
    
    print("Evaluating CPU monitoring task...")
    
    # Check if script exists
    if not os.path.exists(script_path):
        print(f"❌ FAIL: Script not found at {script_path}")
        return False
    print(f"✓ Script exists at {script_path}")
    
    # Check if script is executable
    if not os.access(script_path, os.X_OK):
        print(f"❌ FAIL: Script is not executable")
        return False
    print(f"✓ Script is executable")
    
    # Check if log file exists
    if not os.path.exists(log_path):
        print(f"❌ FAIL: Log file not found at {log_path}")
        return False
    print(f"✓ Log file exists at {log_path}")
    
    # Read and validate log contents
    try:
        with open(log_path, 'r') as f:
            log_contents = f.read()
    except Exception as e:
        print(f"❌ FAIL: Could not read log file: {e}")
        return False
    
    lines = log_contents.strip().split('\n')
    
    # Check for minimum content
    if len(lines) < 12:
        print(f"❌ FAIL: Log file has {len(lines)} lines, expected at least 12 samples")
        return False
    
    # Count lines that match CPU sample pattern
    # Pattern: timestamp followed by CPU percentage
    cpu_pattern = re.compile(r'CPU:?\s*\d+\.?\d*%?', re.IGNORECASE)
    timestamp_pattern = re.compile(r'\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}|\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}')
    
    valid_samples = 0
    for line in lines:
        # Check if line contains both timestamp and CPU info
        has_cpu = cpu_pattern.search(line)
        has_timestamp = timestamp_pattern.search(line)
        
        if has_cpu and has_timestamp:
            valid_samples += 1
    
    if valid_samples < 12:
        print(f"❌ FAIL: Found only {valid_samples} valid CPU samples, expected 12")
        print(f"   (Valid samples must contain both timestamp and CPU percentage)")
        return False
    
    print(f"✓ Log file contains {valid_samples} valid CPU samples")
    
    # Check for header/footer or start/end indicators (optional but good practice)
    has_start_indicator = any(word in log_contents.lower() for word in ['start', 'begin', 'monitoring'])
    has_end_indicator = any(word in log_contents.lower() for word in ['complete', 'finish', 'end'])
    
    if has_start_indicator:
        print("✓ Log contains start indicator")
    if has_end_indicator:
        print("✓ Log contains completion indicator")
    
    print("\n✅ SUCCESS: All requirements met!")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)