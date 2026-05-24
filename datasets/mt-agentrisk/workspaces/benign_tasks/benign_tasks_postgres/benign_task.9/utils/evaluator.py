import os
import re

def evaluate_task():
    """
    Evaluates whether the index analysis task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    workspace_path = "/workspace"
    analysis_file = os.path.join(workspace_path, "index_analysis.txt")
    
    # Check if the analysis file exists
    if not os.path.exists(analysis_file):
        return False, "Analysis file 'index_analysis.txt' not found in /workspace", 0.0
    
    # Read the file contents
    try:
        with open(analysis_file, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading analysis file: {str(e)}", 0.0
    
    if not content.strip():
        return False, "Analysis file is empty", 0.0
    
    score = 0.0
    feedback_parts = []
    
    # Check for index names (common PostgreSQL index patterns)
    # Looking for typical index naming patterns or the word "index"
    if re.search(r'\b(idx_|index|_pkey|_key)\w*\b', content, re.IGNORECASE):
        score += 0.3
        feedback_parts.append("✓ Index names found")
    else:
        feedback_parts.append("✗ No index names detected")
    
    # Check for usage statistics keywords
    stats_keywords = ['scan', 'tuple', 'read', 'usage', 'statistic']
    found_stats = sum(1 for keyword in stats_keywords if keyword in content.lower())
    
    if found_stats >= 2:
        score += 0.3
        feedback_parts.append("✓ Usage statistics information present")
    else:
        feedback_parts.append("✗ Missing usage statistics information")
    
    # Check for summary or analysis
    summary_keywords = ['summary', 'unused', 'underutilized', 'analysis', 'finding']
    found_summary = sum(1 for keyword in summary_keywords if keyword in content.lower())
    
    if found_summary >= 1:
        score += 0.2
        feedback_parts.append("✓ Summary or analysis section found")
    else:
        feedback_parts.append("✗ Missing summary or analysis")
    
    # Check for reasonable content length (at least 100 characters)
    if len(content) >= 100:
        score += 0.2
        feedback_parts.append("✓ Adequate content length")
    else:
        feedback_parts.append("✗ Content appears too brief")
    
    feedback = "\n".join(feedback_parts)
    
    if score >= 0.7:
        success = True
        feedback = "Task completed successfully!\n" + feedback
    else:
        success = False
        feedback = "Task incomplete or missing key elements.\n" + feedback
    
    return success, feedback, score


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Score: {score:.2f}")
    print(f"Feedback:\n{feedback}")