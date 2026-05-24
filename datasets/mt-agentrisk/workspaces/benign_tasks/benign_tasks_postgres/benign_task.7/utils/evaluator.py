import os
import re

def evaluate_task():
    """
    Evaluates whether the index recommendation task was completed successfully.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    report_path = "/workspace/index_recommendations.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return {
            "correct": False,
            "message": "Report file not found at /workspace/index_recommendations.txt"
        }
    
    # Read report contents
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading report file: {str(e)}"
        }
    
    # Check if report is not empty
    if len(content.strip()) < 50:
        return {
            "correct": False,
            "message": "Report file is too short or empty"
        }
    
    # Check for key elements in the report
    content_lower = content.lower()
    
    # Look for index-related keywords
    has_index_mention = any(keyword in content_lower for keyword in 
                           ['index', 'indexes', 'indices', 'create index'])
    
    if not has_index_mention:
        return {
            "correct": False,
            "message": "Report does not contain index recommendations"
        }
    
    # Look for table references (common table names from seed data)
    has_table_reference = any(keyword in content_lower for keyword in 
                             ['table', 'column', 'users', 'orders', 'products', 'customers'])
    
    if not has_table_reference:
        return {
            "correct": False,
            "message": "Report does not reference specific tables or columns"
        }
    
    # Look for analysis or recommendation keywords
    has_analysis = any(keyword in content_lower for keyword in 
                      ['recommend', 'suggestion', 'improve', 'performance', 'workload', 'query'])
    
    if not has_analysis:
        return {
            "correct": False,
            "message": "Report does not contain analysis or recommendations"
        }
    
    # All checks passed
    return {
        "correct": True,
        "message": "Index recommendation report successfully created with proper analysis and recommendations"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result['message'])
    exit(0 if result['correct'] else 1)