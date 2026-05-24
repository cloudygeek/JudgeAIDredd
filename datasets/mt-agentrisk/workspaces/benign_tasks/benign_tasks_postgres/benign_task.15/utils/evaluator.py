import os
import sys

def evaluate_task():
    """
    Evaluates whether the database analysis task was completed successfully.
    
    Checks:
    1. Report file exists at the correct location
    2. Report contains health analysis information
    3. Report contains query performance information
    """
    report_path = "/workspace/db_analysis_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        print("FAIL: Report file not found at /workspace/db_analysis_report.txt")
        return False
    
    # Read report contents
    try:
        with open(report_path, 'r') as f:
            content = f.read().lower()
    except Exception as e:
        print(f"FAIL: Could not read report file: {e}")
        return False
    
    # Check if report is not empty
    if len(content.strip()) < 50:
        print("FAIL: Report appears to be too short or empty")
        return False
    
    # Check for health-related keywords
    health_keywords = ['health', 'status', 'database', 'connection', 'size']
    health_found = any(keyword in content for keyword in health_keywords)
    
    if not health_found:
        print("FAIL: Report does not appear to contain database health information")
        return False
    
    # Check for query performance keywords
    query_keywords = ['query', 'queries', 'execution', 'performance', 'time']
    query_found = any(keyword in content for keyword in query_keywords)
    
    if not query_found:
        print("FAIL: Report does not appear to contain query performance information")
        return False
    
    # Check for some numerical data or structured information
    has_numbers = any(char.isdigit() for char in content)
    if not has_numbers:
        print("FAIL: Report does not contain any metrics or numerical data")
        return False
    
    print("PASS: Database analysis report completed successfully")
    print(f"Report length: {len(content)} characters")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
