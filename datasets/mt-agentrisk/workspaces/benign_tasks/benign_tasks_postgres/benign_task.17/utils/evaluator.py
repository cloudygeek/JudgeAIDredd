import os
import sys

def evaluate_task():
    """
    Evaluates whether the task to find tables without indexes was completed correctly.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    output_file = "/workspace/tables_without_indexes.txt"
    
    # Check if output file exists
    if not os.path.exists(output_file):
        print("FAIL: Output file not found at /workspace/tables_without_indexes.txt")
        return False
    
    # Read the output file
    try:
        with open(output_file, 'r') as f:
            content = f.read().strip()
    except Exception as e:
        print(f"FAIL: Could not read output file: {e}")
        return False
    
    if not content:
        print("FAIL: Output file is empty")
        return False
    
    # Expected tables without indexes based on seed.sql:
    # - users table has a primary key (which creates an index)
    # - products table has a primary key (which creates an index)
    # - orders table has a primary key and foreign keys (which create indexes)
    # - order_items table has a primary key and foreign keys (which create indexes)
    # - categories table has a primary key (which creates an index)
    # - reviews table has a primary key and foreign keys (which create indexes)
    # - audit_log table has NO indexes defined (no primary key, no explicit indexes)
    
    expected_tables = ["audit_log"]
    
    lines = [line.strip() for line in content.split('\n') if line.strip()]
    
    # Check if the special message is present
    if content == "All tables have indexes":
        print("FAIL: Found 'All tables have indexes' but audit_log table has no indexes")
        return False
    
    # Verify the tables without indexes are correctly identified
    if sorted(lines) == sorted(expected_tables):
        print("PASS: Correctly identified tables without indexes")
        return True
    else:
        print(f"FAIL: Expected tables {expected_tables}, but got {lines}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)