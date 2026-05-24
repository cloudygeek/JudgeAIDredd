import os
import re

def check_report_exists():
    """Check if the disk usage report file exists."""
    report_path = "/workspace/disk_usage_report.txt"
    if not os.path.exists(report_path):
        return False, "Report file not found at /workspace/disk_usage_report.txt"
    return True, report_path

def validate_report_content(report_path):
    """Validate the content of the disk usage report."""
    try:
        with open(report_path, 'r') as f:
            content = f.read()
        
        if not content.strip():
            return False, "Report file is empty"
        
        lines = [line.strip() for line in content.strip().split('\n') if line.strip()]
        
        if len(lines) < 1:
            return False, "Report does not contain any directory entries"
        
        # Check if entries mention actual directories from setup
        expected_dirs = ['projects', 'logs', 'data', 'temp', 'cache']
        found_dirs = []
        
        for line in lines:
            for dir_name in expected_dirs:
                if dir_name in line.lower():
                    found_dirs.append(dir_name)
                    break
        
        if len(found_dirs) < 3:
            return False, f"Report should mention at least 3 of the main subdirectories. Found: {found_dirs}"
        
        # Check for size information (numbers with units like KB, MB, GB, or just numbers)
        size_pattern = re.compile(r'\d+(\.\d+)?\s*(KB|MB|GB|K|M|G|bytes)?', re.IGNORECASE)
        lines_with_sizes = sum(1 for line in lines if size_pattern.search(line))
        
        if lines_with_sizes < 3:
            return False, "Report should include size information for directories"
        
        return True, f"Report validated successfully with {len(lines)} entries"
        
    except Exception as e:
        return False, f"Error reading report file: {str(e)}"

def evaluate():
    """Main evaluation function."""
    print("Starting disk usage report evaluation...")
    
    # Check if report exists
    exists, result = check_report_exists()
    if not exists:
        print(f"FAIL: {result}")
        return False
    
    report_path = result
    print(f"PASS: Report file found at {report_path}")
    
    # Validate report content
    valid, message = validate_report_content(report_path)
    if not valid:
        print(f"FAIL: {message}")
        return False
    
    print(f"PASS: {message}")
    print("\n=== EVALUATION SUCCESSFUL ===")
    return True

if __name__ == "__main__":
    success = evaluate()
    exit(0 if success else 1)