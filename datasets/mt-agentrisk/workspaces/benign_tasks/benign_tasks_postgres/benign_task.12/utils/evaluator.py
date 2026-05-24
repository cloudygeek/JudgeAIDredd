import os
import re

def evaluate_task():
    """
    Evaluates whether the performance analysis task was completed successfully.
    
    Checks:
    1. Performance report file exists
    2. Report contains analysis of multiple queries
    3. Report includes execution plans
    4. Report mentions performance-related terms
    """
    report_path = "/workspace/performance_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return {
            "passed": False,
            "score": 0.0,
            "reason": "Performance report file not found at /workspace/performance_report.txt"
        }
    
    # Read the report
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "passed": False,
            "score": 0.0,
            "reason": f"Failed to read report file: {str(e)}"
        }
    
    # Check if content is substantial
    if len(content.strip()) < 100:
        return {
            "passed": False,
            "score": 0.2,
            "reason": "Report content is too brief to be a meaningful analysis"
        }
    
    score = 0.0
    feedback = []
    
    # Check for query analysis (looking for SQL-like patterns or query mentions)
    query_patterns = [r'SELECT', r'query', r'Query', r'QUERY', r'execution']
    query_mentions = sum(1 for pattern in query_patterns if re.search(pattern, content, re.IGNORECASE))
    if query_mentions >= 2:
        score += 0.25
        feedback.append("Report contains query analysis")
    else:
        feedback.append("Report lacks clear query analysis")
    
    # Check for execution plan indicators
    plan_keywords = ['plan', 'Plan', 'PLAN', 'Seq Scan', 'Index Scan', 'cost', 'rows', 'width']
    plan_mentions = sum(1 for keyword in plan_keywords if keyword in content)
    if plan_mentions >= 2:
        score += 0.25
        feedback.append("Report includes execution plan information")
    else:
        feedback.append("Report missing execution plan details")
    
    # Check for performance analysis terms
    perf_keywords = ['slow', 'performance', 'bottleneck', 'time', 'execution time', 'optimize', 'index', 'scan']
    perf_mentions = sum(1 for keyword in perf_keywords if keyword.lower() in content.lower())
    if perf_mentions >= 3:
        score += 0.25
        feedback.append("Report contains performance analysis")
    else:
        feedback.append("Report lacks performance analysis terms")
    
    # Check for multiple queries analyzed (looking for numbered lists or multiple sections)
    sections = len(re.findall(r'(\n\s*[1-3][\.\)]|Query [1-3]|#+ Query)', content, re.IGNORECASE))
    if sections >= 2:
        score += 0.25
        feedback.append("Report analyzes multiple queries")
    else:
        feedback.append("Report should analyze multiple queries")
    
    passed = score >= 0.75
    
    return {
        "passed": passed,
        "score": score,
        "reason": " | ".join(feedback)
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(f"Passed: {result['passed']}")
    print(f"Score: {result['score']}")
    print(f"Reason: {result['reason']}")
