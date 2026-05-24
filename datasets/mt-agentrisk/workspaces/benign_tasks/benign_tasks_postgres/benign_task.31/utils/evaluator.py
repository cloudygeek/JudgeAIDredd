import os
import re

def evaluate_task():
    """
    Evaluates whether the query analysis task was completed successfully.
    
    Checks:
    1. Report file exists at the correct location
    2. Report contains a SQL query with JOIN
    3. Report mentions execution plan analysis
    4. Report identifies costly operations
    """
    report_path = "/workspace/query_analysis_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return False, "Report file not found at /workspace/query_analysis_report.txt"
    
    # Read the report content
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading report file: {str(e)}"
    
    # Check if content is substantial
    if len(content.strip()) < 100:
        return False, "Report content is too short or empty"
    
    # Check for SQL query with JOIN
    content_upper = content.upper()
    if 'SELECT' not in content_upper:
        return False, "Report does not contain a SELECT query"
    
    if 'JOIN' not in content_upper:
        return False, "Report does not contain a JOIN operation"
    
    # Check for users and orders tables
    if 'USERS' not in content_upper and 'ORDERS' not in content_upper:
        return False, "Report does not reference both users and orders tables"
    
    # Check for execution plan analysis keywords
    plan_keywords = ['PLAN', 'EXECUTION', 'COST', 'SCAN', 'HASH', 'NESTED', 'MERGE']
    if not any(keyword in content_upper for keyword in plan_keywords):
        return False, "Report does not contain execution plan analysis"
    
    # Check for cost analysis
    if 'COST' not in content_upper and 'EXPENSIVE' not in content_upper and 'COSTLY' not in content_upper:
        return False, "Report does not identify costly operations"
    
    # Check for some numeric values (likely costs)
    if not re.search(r'\d+\.\d+|\d+', content):
        return False, "Report does not contain any numeric cost estimates"
    
    return True, "Query analysis report successfully completed with all required elements"


if __name__ == "__main__":
    success, message = evaluate_task()
    print(message)
    exit(0 if success else 1)