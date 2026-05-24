import os
import re
from datetime import datetime

def evaluate_task():
    """
    Evaluates whether the disk usage report task was completed successfully.
    
    Returns:
        dict: Result with 'passed' boolean and 'feedback' string
    """
    report_path = "/workspace/disk_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return {
            "passed": False,
            "feedback": f"Report file not found at {report_path}"
        }
    
    # Read the report contents
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "passed": False,
            "feedback": f"Error reading report file: {str(e)}"
        }
    
    # Check if content is not empty
    if not content.strip():
        return {
            "passed": False,
            "feedback": "Report file is empty"
        }
    
    # Check for key disk usage information patterns
    checks = {
        "total_space": False,
        "used_space": False,
        "available_space": False,
        "has_numbers": False
    }
    
    content_lower = content.lower()
    
    # Look for total/size indicators
    if any(word in content_lower for word in ['total', 'size', 'capacity']):
        checks["total_space"] = True
    
    # Look for used space indicators
    if any(word in content_lower for word in ['used', 'occupied']):
        checks["used_space"] = True
    
    # Look for available/free space indicators
    if any(word in content_lower for word in ['available', 'free', 'avail']):
        checks["available_space"] = True
    
    # Check for numeric values (disk sizes)
    # Look for patterns like numbers followed by units (K, M, G, T, KB, MB, GB, TB, etc.)
    if re.search(r'\d+[KMGT]?B?|\d+%|\d+\.\d+[KMGT]?B?', content, re.IGNORECASE):
        checks["has_numbers"] = True
    
    # Count how many checks passed
    passed_checks = sum(checks.values())
    
    # Require at least 3 out of 4 checks to pass
    if passed_checks >= 3:
        return {
            "passed": True,
            "feedback": f"Disk usage report successfully created with appropriate information. File contains {len(content)} characters."
        }
    else:
        failed = [k for k, v in checks.items() if not v]
        return {
            "passed": False,
            "feedback": f"Report exists but missing key information. Failed checks: {', '.join(failed)}"
        }

if __name__ == "__main__":
    result = evaluate_task()
    print(f"Passed: {result['passed']}")
    print(f"Feedback: {result['feedback']}")