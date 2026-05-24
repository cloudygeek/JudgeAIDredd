import os
import re
from datetime import datetime

def evaluate_task():
    """
    Evaluates whether the baseline performance report was created correctly.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    report_path = "/workspace/baseline_performance_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return {
            "correct": False,
            "message": f"Baseline report file not found at {report_path}"
        }
    
    # Read the report content
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading report file: {str(e)}"
        }
    
    # Check if content is not empty
    if not content.strip():
        return {
            "correct": False,
            "message": "Report file is empty"
        }
    
    # Check for key sections that should be present
    required_indicators = [
        (r"(health|database|metrics)", "database health information"),
        (r"(queries|query|top)", "query performance information"),
        (r"(connection|cache|hit ratio)", "connection or cache metrics"),
    ]
    
    missing_sections = []
    for pattern, description in required_indicators:
        if not re.search(pattern, content, re.IGNORECASE):
            missing_sections.append(description)
    
    if missing_sections:
        return {
            "correct": False,
            "message": f"Report is missing expected sections: {', '.join(missing_sections)}"
        }
    
    # Check for timestamp or date information
    has_timestamp = bool(re.search(r"\d{4}[-/]\d{2}[-/]\d{2}", content)) or \
                   bool(re.search(r"(timestamp|date|time|generated)", content, re.IGNORECASE))
    
    if not has_timestamp:
        return {
            "correct": False,
            "message": "Report should include a timestamp or date"
        }
    
    # Check minimum content length (should be substantial)
    if len(content) < 200:
        return {
            "correct": False,
            "message": "Report content seems too brief. Expected more detailed metrics."
        }
    
    # All checks passed
    return {
        "correct": True,
        "message": "Baseline performance report successfully created with all required sections"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result["message"])
    exit(0 if result["correct"] else 1)