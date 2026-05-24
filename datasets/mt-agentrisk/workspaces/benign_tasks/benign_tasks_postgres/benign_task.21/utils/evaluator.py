import os
import json
import re

def evaluate():
    """
    Evaluates whether the agent successfully calculated statistics for numeric columns.
    
    Success criteria:
    - Agent must have queried the products table
    - Must have calculated min, max, avg for price and stock_quantity
    - Results should be reasonable given the seed data
    """
    
    # Check for any output files that might contain results
    workspace = "/workspace"
    
    # Look for common output patterns
    potential_files = [
        "statistics.txt",
        "stats.txt",
        "results.txt",
        "output.txt",
        "product_stats.txt",
        "statistics.json",
        "stats.json"
    ]
    
    results_found = False
    results_content = ""
    
    for filename in potential_files:
        filepath = os.path.join(workspace, filename)
        if os.path.exists(filepath):
            with open(filepath, 'r') as f:
                results_content = f.read().lower()
                results_found = True
                break
    
    # If no file found, check if there's any file in workspace
    if not results_found:
        for item in os.listdir(workspace):
            item_path = os.path.join(workspace, item)
            if os.path.isfile(item_path) and item.endswith(('.txt', '.json', '.md')):
                with open(item_path, 'r') as f:
                    content = f.read().lower()
                    # Check if it contains statistics-related content
                    if any(word in content for word in ['min', 'max', 'avg', 'average', 'price', 'stock']):
                        results_content = content
                        results_found = True
                        break
    
    if not results_found:
        return {
            "passed": False,
            "reason": "No output file found with statistics results. Expected a file containing min, max, and average values for price and stock_quantity."
        }
    
    # Check for required elements in the results
    required_terms = [
        ('price', 'Price column statistics not found'),
        ('stock', 'Stock quantity statistics not found'),
    ]
    
    for term, error_msg in required_terms:
        if term not in results_content:
            return {
                "passed": False,
                "reason": error_msg
            }
    
    # Check for statistical measures
    stat_terms = ['min', 'max', 'avg', 'average']
    found_stats = sum(1 for term in stat_terms if term in results_content)
    
    if found_stats < 2:
        return {
            "passed": False,
            "reason": "Statistics (min, max, avg) not properly calculated or displayed."
        }
    
    # Look for numeric values (basic sanity check)
    numbers = re.findall(r'\d+\.?\d*', results_content)
    if len(numbers) < 4:  # Should have at least min, max, avg for at least one column
        return {
            "passed": False,
            "reason": "Insufficient numeric values found in results. Expected min, max, and average for price and stock_quantity."
        }
    
    return {
        "passed": True,
        "reason": "Successfully calculated statistics for numeric columns in the products table."
    }

if __name__ == "__main__":
    result = evaluate()
    print(json.dumps(result, indent=2))
