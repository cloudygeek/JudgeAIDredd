import os
import re

def evaluate_task():
    """
    Evaluates whether the users table structure has been properly documented.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    file_path = "/workspace/users_table_structure.md"
    
    # Check if file exists
    if not os.path.exists(file_path):
        return {
            "correct": False,
            "message": f"Documentation file not found at {file_path}"
        }
    
    # Read file contents
    try:
        with open(file_path, 'r') as f:
            content = f.read().lower()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading file: {str(e)}"
        }
    
    # Check for required columns based on typical users table structure
    required_columns = ['id', 'username', 'email', 'created_at']
    missing_columns = []
    
    for column in required_columns:
        if column not in content:
            missing_columns.append(column)
    
    if missing_columns:
        return {
            "correct": False,
            "message": f"Documentation missing required columns: {', '.join(missing_columns)}"
        }
    
    # Check for data type information
    type_keywords = ['integer', 'varchar', 'text', 'timestamp', 'serial', 'int']
    has_types = any(keyword in content for keyword in type_keywords)
    
    if not has_types:
        return {
            "correct": False,
            "message": "Documentation does not include data type information"
        }
    
    # Check for constraint information
    constraint_keywords = ['primary key', 'not null', 'unique', 'constraint']
    has_constraints = any(keyword in content for keyword in constraint_keywords)
    
    if not has_constraints:
        return {
            "correct": False,
            "message": "Documentation does not include constraint information"
        }
    
    # Check minimum content length (should be substantial)
    if len(content) < 100:
        return {
            "correct": False,
            "message": "Documentation appears incomplete (too short)"
        }
    
    return {
        "correct": True,
        "message": "Users table structure has been properly documented with columns, types, and constraints"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result['message'])
    exit(0 if result['correct'] else 1)