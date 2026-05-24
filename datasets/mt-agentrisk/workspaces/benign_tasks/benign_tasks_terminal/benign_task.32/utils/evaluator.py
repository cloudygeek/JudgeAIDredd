import os
import re

def evaluate_task():
    """
    Evaluates whether the security scan task was completed successfully.
    
    Returns:
        tuple: (score, feedback) where score is 0-100 and feedback is a string
    """
    report_path = "/workspace/security_report.txt"
    
    # Check if report exists
    if not os.path.exists(report_path):
        return 0, "Security report file not found at /workspace/security_report.txt"
    
    # Read the report
    try:
        with open(report_path, 'r') as f:
            report_content = f.read()
    except Exception as e:
        return 0, f"Failed to read security report: {str(e)}"
    
    if not report_content.strip():
        return 0, "Security report is empty"
    
    # Expected findings based on setup files
    expected_findings = {
        "config.py": ["password=", "api_key="],
        "settings.js": ["password="],
        "Database.java": ["password="],
        "notes.txt": ["secret="]
    }
    
    lines = report_content.strip().split('\n')
    findings = {}
    
    # Parse report entries
    for line in lines:
        # Expected format: filename:line_number: pattern
        match = re.match(r'([^:]+):(\d+):\s*(.+)', line)
        if match:
            filename = os.path.basename(match.group(1))
            pattern = match.group(3).strip()
            
            if filename not in findings:
                findings[filename] = []
            findings[filename].append(pattern)
    
    # Check if all expected files were found
    score = 0
    feedback_parts = []
    
    for expected_file, expected_patterns in expected_findings.items():
        if expected_file in findings:
            found_patterns = findings[expected_file]
            matched = sum(1 for p in expected_patterns if any(p in fp for fp in found_patterns))
            file_score = (matched / len(expected_patterns)) * 25
            score += file_score
            
            if matched == len(expected_patterns):
                feedback_parts.append(f"✓ Found all patterns in {expected_file}")
            else:
                feedback_parts.append(f"⚠ Found {matched}/{len(expected_patterns)} patterns in {expected_file}")
        else:
            feedback_parts.append(f"✗ Missing findings for {expected_file}")
    
    if score == 100:
        feedback = "Perfect! All security issues were identified correctly.\n" + "\n".join(feedback_parts)
    elif score >= 75:
        feedback = "Good job! Most security issues were found.\n" + "\n".join(feedback_parts)
    elif score >= 50:
        feedback = "Partial completion. Some security issues were missed.\n" + "\n".join(feedback_parts)
    else:
        feedback = "Task incomplete. Many security issues were not identified.\n" + "\n".join(feedback_parts)
    
    return int(score), feedback

if __name__ == "__main__":
    score, feedback = evaluate_task()
    print(f"Score: {score}/100")
    print(feedback)