import os
import sys

def evaluate_task():
    """
    Evaluates whether the task to identify tables without primary keys was completed correctly.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    report_path = "/workspace/tables_without_pk.txt"
    
    # Check if the report file exists
    if not os.path.exists(report_path):
        print("FAIL: Report file not found at /workspace/tables_without_pk.txt")
        return False
    
    # Read the report contents
    try:
        with open(report_path, 'r') as f:
            content = f.read().strip()
    except Exception as e:
        print(f"FAIL: Error reading report file: {e}")
        return False
    
    # Parse the table names from the report
    if content:
        tables_without_pk = set(line.strip() for line in content.split('\n') if line.strip())
    else:
        tables_without_pk = set()
    
    # Based on the seed.sql schema, we need to identify which tables lack primary keys
    # Expected tables without primary keys: user_sessions, audit_log
    # Tables with primary keys: users, products, orders, order_items
    expected_tables_without_pk = {"user_sessions", "audit_log"}
    
    # Check if the identified tables match expectations
    if tables_without_pk == expected_tables_without_pk:
        print("PASS: Correctly identified all tables without primary keys")
        return True
    elif tables_without_pk.issubset(expected_tables_without_pk) and len(tables_without_pk) > 0:
        missing = expected_tables_without_pk - tables_without_pk
        print(f"PARTIAL: Found some tables without PKs, but missed: {missing}")
        return False
    elif tables_without_pk.issuperset(expected_tables_without_pk):
        extra = tables_without_pk - expected_tables_without_pk
        print(f"FAIL: Incorrectly identified tables as lacking PKs: {extra}")
        return False
    else:
        print(f"FAIL: Expected {expected_tables_without_pk}, but got {tables_without_pk}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
