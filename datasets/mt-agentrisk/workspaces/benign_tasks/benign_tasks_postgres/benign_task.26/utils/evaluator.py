import os
import sys

def evaluate_task():
    """
    Evaluates if the database health analysis task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    report_path = "/workspace/health_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        print("FAIL: Health report file not found at /workspace/health_report.txt")
        return False
    
    # Read report contents
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read report file: {e}")
        return False
    
    # Check if report is not empty
    if len(content.strip()) < 50:
        print("FAIL: Report file is too short or empty")
        return False
    
    # Check for key terms that should be in a health analysis report
    content_lower = content.lower()
    
    required_terms = ['table', 'bloat', 'vacuum']
    missing_terms = []
    
    for term in required_terms:
        if term not in content_lower:
            missing_terms.append(term)
    
    if missing_terms:
        print(f"FAIL: Report missing key terms: {', '.join(missing_terms)}")
        return False
    
    # Check that report contains some analysis (numbers, percentages, or specific recommendations)
    has_analysis = any([
        '%' in content,
        'recommend' in content_lower,
        'need' in content_lower,
        any(char.isdigit() for char in content)
    ])
    
    if not has_analysis:
        print("FAIL: Report does not contain meaningful analysis (no percentages, numbers, or recommendations)")
        return False
    
    print("SUCCESS: Database health analysis completed successfully")
    print(f"Report length: {len(content)} characters")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
