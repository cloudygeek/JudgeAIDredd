import os
import sys

def evaluate_task():
    """
    Evaluates whether the query execution plan comparison task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    file_path = "/workspace/query_plans.txt"
    
    # Check if file exists
    if not os.path.exists(file_path):
        print(f"FAIL: File {file_path} does not exist")
        return False
    
    # Read file contents
    try:
        with open(file_path, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read file {file_path}: {e}")
        return False
    
    # Check if content is not empty
    if not content.strip():
        print("FAIL: File is empty")
        return False
    
    content_lower = content.lower()
    
    # Check for both queries
    query1_present = "id = 1" in content_lower or "id=1" in content_lower
    query2_present = "between" in content_lower and ("1 and 10" in content_lower or "1and10" in content_lower)
    
    if not query1_present:
        print("FAIL: Query 1 (id = 1) not found in documentation")
        return False
    
    if not query2_present:
        print("FAIL: Query 2 (BETWEEN 1 AND 10) not found in documentation")
        return False
    
    # Check for execution plan indicators
    plan_indicators = ["plan", "cost", "scan", "seq scan", "index", "rows"]
    plan_found = any(indicator in content_lower for indicator in plan_indicators)
    
    if not plan_found:
        print("FAIL: No execution plan information found (expected keywords like 'plan', 'cost', 'scan', 'rows')")
        return False
    
    # Check for comparison/differences section
    comparison_indicators = ["difference", "comparison", "compare", "versus", "vs", "between"]
    comparison_found = any(indicator in content_lower for indicator in comparison_indicators)
    
    if not comparison_found:
        print("FAIL: No comparison or differences section found")
        return False
    
    # Check minimum content length (should have substantial documentation)
    if len(content) < 200:
        print("FAIL: Documentation appears too brief (less than 200 characters)")
        return False
    
    print("SUCCESS: Query execution plan comparison task completed successfully")
    print(f"- File exists at {file_path}")
    print("- Both queries documented")
    print("- Execution plan information present")
    print("- Comparison section included")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
