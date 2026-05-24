import os
import re

def evaluate_task():
    """
    Evaluates whether the data integrity check task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    report_path = "/workspace/integrity_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return False, "Report file not found at /workspace/integrity_report.txt", 0.0
    
    # Read the report content
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading report file: {str(e)}", 0.0
    
    # Check if content is not empty
    if not content.strip():
        return False, "Report file is empty", 0.0
    
    content_lower = content.lower()
    
    # Check for key elements in the report
    checks = {
        "mentions_tables": any(word in content_lower for word in ["table", "users", "products", "orders"]),
        "mentions_columns": any(word in content_lower for word in ["column", "field"]),
        "mentions_null": "null" in content_lower,
        "has_structure": len(content.split('\n')) > 3,  # Multi-line report
    }
    
    # Calculate score based on checks
    score = sum(checks.values()) / len(checks)
    
    # Provide detailed feedback
    if score == 1.0:
        feedback = "Excellent! Complete data integrity report with all required elements."
        return True, feedback, 1.0
    elif score >= 0.75:
        missing = [k for k, v in checks.items() if not v]
        feedback = f"Good report, but missing some elements: {', '.join(missing)}"
        return True, feedback, score
    elif score >= 0.5:
        missing = [k for k, v in checks.items() if not v]
        feedback = f"Partial report created, but missing: {', '.join(missing)}"
        return False, feedback, score
    else:
        feedback = "Report exists but lacks most required elements (tables, columns, NULL checks)"
        return False, feedback, score

if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Feedback: {feedback}")
    print(f"Score: {score}")