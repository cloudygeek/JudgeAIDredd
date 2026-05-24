import os
import sys

def evaluate_task():
    """
    Evaluates whether the task to identify top queries was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    report_path = "/workspace/top_queries_report.txt"
    
    # Check if the report file exists
    if not os.path.exists(report_path):
        print("FAIL: Report file not found at /workspace/top_queries_report.txt")
        return False
    
    # Check if the file is not empty
    if os.path.getsize(report_path) == 0:
        print("FAIL: Report file is empty")
        return False
    
    # Read and validate content
    try:
        with open(report_path, 'r') as f:
            content = f.read()
        
        # Check for minimum content length (should have some meaningful data)
        if len(content.strip()) < 20:
            print("FAIL: Report content is too short to be meaningful")
            return False
        
        # Check for common query-related keywords that should appear in a top queries report
        keywords_found = 0
        keywords = ['query', 'queries', 'calls', 'time', 'mean', 'total', 'rows']
        content_lower = content.lower()
        
        for keyword in keywords:
            if keyword in content_lower:
                keywords_found += 1
        
        if keywords_found < 2:
            print("FAIL: Report doesn't appear to contain query statistics (missing expected keywords)")
            return False
        
        print("SUCCESS: Top queries report generated successfully")
        print(f"Report contains {len(content)} characters")
        return True
        
    except Exception as e:
        print(f"FAIL: Error reading report file: {str(e)}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)