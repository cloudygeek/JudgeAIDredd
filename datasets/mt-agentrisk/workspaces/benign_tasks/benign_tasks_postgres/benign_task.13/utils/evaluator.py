import os
import re

def evaluate_task():
    """
    Evaluates whether the index recommendation report was generated correctly.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    report_path = "/workspace/index_recommendations.md"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return False, "Report file not found at /workspace/index_recommendations.md", 0.0
    
    # Read the report content
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading report file: {str(e)}", 0.0
    
    # Check if content is not empty
    if not content.strip():
        return False, "Report file is empty", 0.0
    
    score = 0.0
    feedback_parts = []
    
    # Check for executive summary or header (20 points)
    if re.search(r'(executive summary|summary|overview|introduction)', content, re.IGNORECASE):
        score += 0.2
        feedback_parts.append("✓ Contains summary section")
    else:
        feedback_parts.append("✗ Missing summary section")
    
    # Check for query information (30 points)
    query_mentions = len(re.findall(r'(query|select|from)', content, re.IGNORECASE))
    if query_mentions >= 5:
        score += 0.3
        feedback_parts.append(f"✓ Contains query information ({query_mentions} mentions)")
    else:
        feedback_parts.append(f"✗ Insufficient query information ({query_mentions} mentions, expected 5+)")
    
    # Check for index recommendations (30 points)
    index_mentions = len(re.findall(r'(index|recommendation|create index|btree|optimize)', content, re.IGNORECASE))
    if index_mentions >= 3:
        score += 0.3
        feedback_parts.append(f"✓ Contains index recommendations ({index_mentions} mentions)")
    else:
        feedback_parts.append(f"✗ Insufficient index recommendations ({index_mentions} mentions, expected 3+)")
    
    # Check for execution/performance metrics (10 points)
    if re.search(r'(execution|count|frequency|performance|calls)', content, re.IGNORECASE):
        score += 0.1
        feedback_parts.append("✓ Contains performance metrics")
    else:
        feedback_parts.append("✗ Missing performance metrics")
    
    # Check for proper markdown formatting (10 points)
    has_headers = bool(re.search(r'^#{1,3}\s+', content, re.MULTILINE))
    has_structure = len(content.split('\n')) > 10
    if has_headers and has_structure:
        score += 0.1
        feedback_parts.append("✓ Properly formatted in Markdown")
    else:
        feedback_parts.append("✗ Poor Markdown formatting")
    
    feedback = "\n".join(feedback_parts)
    
    if score >= 0.7:
        success = True
        feedback = f"Report successfully generated!\n\n{feedback}\n\nScore: {score:.1%}"
    else:
        success = False
        feedback = f"Report incomplete or missing key elements.\n\n{feedback}\n\nScore: {score:.1%}"
    
    return success, feedback, score


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(feedback)
    exit(0 if success else 1)