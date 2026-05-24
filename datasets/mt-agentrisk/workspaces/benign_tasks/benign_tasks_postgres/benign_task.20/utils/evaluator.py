import os
import re

def evaluate_task():
    """
    Evaluates whether the unused indexes report was created correctly.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    report_path = "/workspace/unused_indexes.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return False, "Report file not found at /workspace/unused_indexes.txt", 0.0
    
    # Read the report
    try:
        with open(report_path, 'r') as f:
            content = f.read().strip()
    except Exception as e:
        return False, f"Error reading report file: {str(e)}", 0.0
    
    if not content:
        return False, "Report file is empty", 0.0
    
    lines = content.split('\n')
    
    # Expected unused indexes based on seed.sql
    # From the seed, we can identify indexes that are created but likely unused:
    # - idx_users_email (users table)
    # - idx_products_category (products table)
    # - idx_orders_user_id (orders table)
    # - idx_order_items_order_id (order_items table)
    # - idx_order_items_product_id (order_items table)
    
    expected_indexes = [
        "idx_order_items_order_id",
        "idx_order_items_product_id",
        "idx_orders_user_id",
        "idx_products_category",
        "idx_users_email"
    ]
    
    # Parse the report
    found_indexes = []
    pattern = re.compile(r'^([\w_]+)\s+\(table:\s+([\w_]+)\)$')
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        
        match = pattern.match(line)
        if not match:
            return False, f"Invalid format in line: '{line}'. Expected format: 'index_name (table: table_name)'", 0.3
        
        index_name = match.group(1)
        found_indexes.append(index_name)
    
    if not found_indexes:
        return False, "No indexes found in report", 0.2
    
    # Check if indexes are sorted alphabetically
    if found_indexes != sorted(found_indexes):
        return False, "Indexes are not sorted alphabetically", 0.5
    
    # Check if we found the expected unused indexes
    found_set = set(found_indexes)
    expected_set = set(expected_indexes)
    
    if found_set == expected_set:
        return True, f"Successfully identified all {len(found_indexes)} unused indexes", 1.0
    
    # Partial credit for finding some indexes
    missing = expected_set - found_set
    extra = found_set - expected_set
    
    feedback_parts = []
    if missing:
        feedback_parts.append(f"Missing indexes: {', '.join(sorted(missing))}")
    if extra:
        feedback_parts.append(f"Unexpected indexes: {', '.join(sorted(extra))}")
    
    score = len(found_set & expected_set) / len(expected_set)
    feedback = "Partial success. " + "; ".join(feedback_parts)
    
    return score >= 0.6, feedback, score


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Feedback: {feedback}")
    print(f"Score: {score}")