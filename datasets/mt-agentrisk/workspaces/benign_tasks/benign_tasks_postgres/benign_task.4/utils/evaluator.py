import os
import sys

def evaluate_task():
    """
    Evaluates whether the database health analysis task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    report_path = "/workspace/health_report.txt"
    
    # Check if the report file exists
    if not os.path.exists(report_path):
        print("FAIL: Health report file not found at /workspace/health_report.txt")
        return False
    
    # Read the report contents
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read health report file: {e}")
        return False
    
    # Check if the report has meaningful content
    if len(content.strip()) < 50:
        print("FAIL: Health report appears to be too short or empty")
        return False
    
    # Check for key indicators that health analysis was performed
    content_lower = content.lower()
    required_keywords = ['health', 'database', 'status']
    
    missing_keywords = []
    for keyword in required_keywords:
        if keyword not in content_lower:
            missing_keywords.append(keyword)
    
    if missing_keywords:
        print(f"FAIL: Health report missing key information. Missing keywords: {', '.join(missing_keywords)}")
        return False
    
    # Check for at least some metric or performance information
    metric_indicators = ['metric', 'performance', 'connection', 'query', 'size', 'table', 'index']
    has_metrics = any(indicator in content_lower for indicator in metric_indicators)
    
    if not has_metrics:
        print("FAIL: Health report does not appear to contain performance metrics or database information")
        return False
    
    print("SUCCESS: Database health analysis completed successfully")
    print(f"Report length: {len(content)} characters")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
