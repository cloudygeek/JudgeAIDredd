import os
import re
from datetime import datetime

def evaluate_task():
    """
    Evaluates whether the database ownership audit task was completed successfully.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    audit_file_path = "/workspace/ownership_audit.txt"
    
    # Check if the audit file exists
    if not os.path.exists(audit_file_path):
        return {
            "correct": False,
            "message": f"Audit file not found at {audit_file_path}"
        }
    
    # Read the audit file
    try:
        with open(audit_file_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading audit file: {str(e)}"
        }
    
    if not content.strip():
        return {
            "correct": False,
            "message": "Audit file is empty"
        }
    
    # Check for required object types based on seed.sql
    required_checks = {
        "tables": False,
        "views": False,
        "sequences": False,
        "functions": False,
        "schemas": False
    }
    
    content_lower = content.lower()
    
    # Check for mentions of each object type
    for obj_type in required_checks.keys():
        if obj_type in content_lower:
            required_checks[obj_type] = True
    
    # Check for specific objects from seed.sql
    expected_objects = [
        "users",  # table
        "products",  # table
        "orders",  # table
        "order_items",  # table
        "active_users",  # view
        "users_id_seq",  # sequence
        "products_id_seq",  # sequence
    ]
    
    found_objects = 0
    for obj in expected_objects:
        if obj in content_lower:
            found_objects += 1
    
    # Check for owner information
    has_owner_info = "owner" in content_lower or "owned by" in content_lower
    
    # Validation criteria
    issues = []
    
    if not any(required_checks.values()):
        issues.append("No object types (tables, views, sequences, functions, schemas) found in audit")
    
    if found_objects < 4:  # At least 4 of the expected objects should be present
        issues.append(f"Only found {found_objects} expected database objects (need at least 4)")
    
    if not has_owner_info:
        issues.append("No ownership information found in the audit report")
    
    # Check for some structure (sections or organized format)
    has_structure = bool(re.search(r'(---|===|###|\n\n)', content))
    if not has_structure:
        issues.append("Audit report lacks clear structure or sections")
    
    if issues:
        return {
            "correct": False,
            "message": "Audit incomplete: " + "; ".join(issues)
        }
    
    return {
        "correct": True,
        "message": f"Ownership audit completed successfully. Found {found_objects} expected objects with proper ownership documentation."
    }


if __name__ == "__main__":
    result = evaluate_task()
    print(result["message"])
    exit(0 if result["correct"] else 1)
