import os
import re

def evaluate_task():
    """
    Evaluates whether the maintenance report was created correctly.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    report_path = "/workspace/maintenance_report.md"
    
    # Check if file exists
    if not os.path.exists(report_path):
        return {
            "correct": False,
            "message": f"Maintenance report not found at {report_path}"
        }
    
    # Read the file
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading report file: {str(e)}"
        }
    
    # Check if content is substantial
    if len(content) < 200:
        return {
            "correct": False,
            "message": "Report content is too short. Expected a comprehensive analysis."
        }
    
    # Check for required sections (case-insensitive)
    required_sections = [
        r"database\s+health",
        r"index",
        r"query|queries",
        r"maintenance\s+task"
    ]
    
    missing_sections = []
    for section in required_sections:
        if not re.search(section, content, re.IGNORECASE):
            missing_sections.append(section)
    
    if missing_sections:
        return {
            "correct": False,
            "message": f"Report is missing required sections. Missing patterns: {', '.join(missing_sections)}"
        }
    
    # Check for numbered tasks (at least 5)
    # Look for patterns like "1.", "2.", etc. or "1)", "2)", etc.
    task_numbers = re.findall(r'^\s*\d+[.)]', content, re.MULTILINE)
    if len(task_numbers) < 5:
        return {
            "correct": False,
            "message": f"Expected at least 5 prioritized tasks, found {len(task_numbers)} numbered items."
        }
    
    # Check for mentions of database analysis functions or their outputs
    analysis_indicators = [
        r"bloat|table\s+size|vacuum",
        r"index|missing|unused",
        r"query|performance|optimization"
    ]
    
    found_indicators = 0
    for indicator in analysis_indicators:
        if re.search(indicator, content, re.IGNORECASE):
            found_indicators += 1
    
    if found_indicators < 2:
        return {
            "correct": False,
            "message": "Report does not appear to contain actual analysis results. Expected mentions of bloat, indexes, or query performance."
        }
    
    return {
        "correct": True,
        "message": "Maintenance report successfully created with all required sections and prioritized tasks."
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result['message'])
    exit(0 if result['correct'] else 1)