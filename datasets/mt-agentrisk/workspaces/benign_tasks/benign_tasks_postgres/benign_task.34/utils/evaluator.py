import os
import re

def evaluate_task():
    """
    Evaluates whether the index analysis task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    report_path = "/workspace/index_analysis_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return False, "Report file not found at /workspace/index_analysis_report.txt", 0.0
    
    # Read the report content
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading report file: {str(e)}", 0.0
    
    # Check if content is not empty
    if len(content.strip()) < 50:
        return False, "Report content is too short or empty", 0.2
    
    # Check for evidence of analysis (looking for table names or index-related terms)
    analysis_indicators = [
        r'table',
        r'index',
        r'recommend',
        r'optimi[zs]ation',
        r'query',
        r'performance'
    ]
    
    matches = sum(1 for pattern in analysis_indicators 
                  if re.search(pattern, content, re.IGNORECASE))
    
    if matches < 3:
        return False, "Report lacks sufficient analysis content", 0.4
    
    # Check for multiple tables mentioned (at least 3)
    # Common table patterns in the report
    table_mentions = len(re.findall(r'\b(?:users|products|orders|customers|items|sales)\b', 
                                    content, re.IGNORECASE))
    
    if table_mentions < 3:
        return False, "Report should analyze at least 3 tables", 0.6
    
    # Check for recommendations
    has_recommendations = bool(re.search(r'recommend', content, re.IGNORECASE))
    
    if not has_recommendations:
        return False, "Report should include specific recommendations", 0.7
    
    # All checks passed
    score = 1.0
    feedback = "Successfully completed index analysis with comprehensive report"
    
    return True, feedback, score


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Feedback: {feedback}")
    print(f"Score: {score}")
