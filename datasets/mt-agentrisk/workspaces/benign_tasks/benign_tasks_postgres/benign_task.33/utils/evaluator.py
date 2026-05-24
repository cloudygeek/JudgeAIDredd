import os
import sys

def evaluate_task():
    """
    Evaluates whether the query performance report was created successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    report_path = "/workspace/query_performance_report.txt"
    
    # Check if the report file exists
    if not os.path.exists(report_path):
        print("FAIL: Report file not found at /workspace/query_performance_report.txt")
        return False
    
    # Read the report content
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read report file: {e}")
        return False
    
    # Check if content is not empty
    if not content.strip():
        print("FAIL: Report file is empty")
        return False
    
    # Check for basic report structure
    content_lower = content.lower()
    
    # Look for header or title
    has_header = any(keyword in content_lower for keyword in [
        "top", "query", "queries", "performance", "report", "resource"
    ])
    
    if not has_header:
        print("FAIL: Report does not contain expected header or title")
        return False
    
    # Check for query-related content
    has_query_info = any(keyword in content_lower for keyword in [
        "select", "query", "execution", "time", "cpu", "resource"
    ])
    
    if not has_query_info:
        print("FAIL: Report does not contain query performance information")
        return False
    
    # Check minimum content length (should have substantial information)
    if len(content) < 50:
        print("FAIL: Report content is too short to be meaningful")
        return False
    
    print("SUCCESS: Query performance report created successfully")
    print(f"Report length: {len(content)} characters")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)