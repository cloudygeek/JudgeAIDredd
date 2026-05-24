import os
import re

def evaluate_task():
    """
    Evaluates whether the query optimization task was completed successfully.
    
    Checks:
    1. Report file exists at the correct location
    2. Report contains query text
    3. Report contains performance metrics
    4. Report contains execution plan information
    5. Report contains index recommendations
    """
    report_path = "/workspace/query_optimization_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return {
            "passed": False,
            "reason": f"Report file not found at {report_path}"
        }
    
    # Read report contents
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "passed": False,
            "reason": f"Failed to read report file: {str(e)}"
        }
    
    # Check if content is substantial
    if len(content.strip()) < 100:
        return {
            "passed": False,
            "reason": "Report content is too short or empty"
        }
    
    # Check for query text (SQL keywords)
    sql_keywords = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'GROUP BY', 'ORDER BY']
    has_query = any(keyword in content.upper() for keyword in sql_keywords)
    
    if not has_query:
        return {
            "passed": False,
            "reason": "Report does not contain SQL query text"
        }
    
    # Check for performance metrics
    metric_indicators = ['time', 'execution', 'calls', 'ms', 'seconds', 'performance']
    has_metrics = any(indicator in content.lower() for indicator in metric_indicators)
    
    if not has_metrics:
        return {
            "passed": False,
            "reason": "Report does not contain performance metrics"
        }
    
    # Check for execution plan information
    plan_indicators = ['plan', 'scan', 'cost', 'rows', 'explain']
    has_plan = any(indicator in content.lower() for indicator in plan_indicators)
    
    if not has_plan:
        return {
            "passed": False,
            "reason": "Report does not contain execution plan analysis"
        }
    
    # Check for index recommendations
    index_indicators = ['index', 'create index', 'btree', 'recommendation', 'suggest', 'improve']
    has_index_rec = any(indicator in content.lower() for indicator in index_indicators)
    
    if not has_index_rec:
        return {
            "passed": False,
            "reason": "Report does not contain index recommendations"
        }
    
    return {
        "passed": True,
        "reason": "Query optimization report successfully created with all required components"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result)