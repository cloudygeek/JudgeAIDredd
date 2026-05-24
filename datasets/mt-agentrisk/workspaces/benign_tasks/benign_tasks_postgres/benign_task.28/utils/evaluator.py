import os
import re

def evaluate_task():
    """
    Evaluates whether the index analysis report was created correctly.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    report_path = "/workspace/index_analysis_report.md"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return {
            "correct": False,
            "message": "Report file not found at /workspace/index_analysis_report.md"
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
    if len(content.strip()) < 100:
        return {
            "correct": False,
            "message": "Report appears to be too short or empty"
        }
    
    # Check for required sections (case-insensitive)
    required_sections = [
        r"(executive\s+summary|summary|overview)",
        r"(existing\s+indexes|current\s+indexes|index\s+inventory)",
        r"(usage|utilization|statistics)",
        r"(optimization|recommendations|improvements)"
    ]
    
    missing_sections = []
    content_lower = content.lower()
    
    for section_pattern in required_sections:
        if not re.search(section_pattern, content_lower):
            missing_sections.append(section_pattern)
    
    if missing_sections:
        return {
            "correct": False,
            "message": f"Report is missing required sections. Could not find patterns: {missing_sections}"
        }
    
    # Check for evidence of actual database analysis
    # Look for common database-related terms
    db_terms = ["index", "table", "column", "database"]
    db_term_count = sum(1 for term in db_terms if term in content_lower)
    
    if db_term_count < 3:
        return {
            "correct": False,
            "message": "Report does not appear to contain sufficient database analysis content"
        }
    
    # Check for markdown formatting
    if not re.search(r"^#+\s+", content, re.MULTILINE):
        return {
            "correct": False,
            "message": "Report does not appear to use markdown headers"
        }
    
    # Success - report exists with required sections and content
    return {
        "correct": True,
        "message": "Index analysis report successfully created with all required sections and proper formatting"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result["message"])
    exit(0 if result["correct"] else 1)