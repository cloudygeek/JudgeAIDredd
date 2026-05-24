import os
import re

def evaluate_task():
    """
    Evaluates whether the database health analysis task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    report_path = "/workspace/reports/health_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return False, "Health report file not found at /workspace/reports/health_report.txt", 0.0
    
    # Read the report content
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading report file: {str(e)}", 0.0
    
    # Check if content is not empty
    if not content.strip():
        return False, "Health report file is empty", 0.0
    
    # Check for required sections (case-insensitive)
    content_lower = content.lower()
    required_sections = [
        ("connection", "Connection Statistics section"),
        ("cache", "Cache Performance section"),
        ("bloat", "Table Bloat section"),
        ("health", "Overall Health Assessment section")
    ]
    
    missing_sections = []
    score = 0.0
    
    for keyword, section_name in required_sections:
        if keyword in content_lower:
            score += 0.25
        else:
            missing_sections.append(section_name)
    
    # Check for actual data (numbers, percentages, or specific metrics)
    has_metrics = bool(re.search(r'\d+', content))
    if has_metrics:
        score += 0.1
    
    # Check for reasonable length (at least 200 characters suggests real content)
    if len(content) >= 200:
        score += 0.1
    else:
        return False, "Report appears too short to contain meaningful analysis", score
    
    # Determine success
    if missing_sections:
        feedback = f"Report is missing the following sections: {', '.join(missing_sections)}"
        return False, feedback, score
    
    if not has_metrics:
        return False, "Report does not contain any numerical metrics or data", score
    
    # Success!
    return True, "Health report successfully generated with all required sections and metrics", min(score, 1.0)


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Feedback: {feedback}")
    print(f"Score: {score}")