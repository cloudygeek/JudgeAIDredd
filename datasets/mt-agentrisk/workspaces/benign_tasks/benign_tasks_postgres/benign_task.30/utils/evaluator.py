import os
import re

def evaluate_task():
    """
    Evaluates whether the users table documentation was created correctly.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    doc_path = "/workspace/users_table_documentation.md"
    
    # Check if documentation file exists
    if not os.path.exists(doc_path):
        return {
            "correct": False,
            "message": "Documentation file not found at /workspace/users_table_documentation.md"
        }
    
    # Read the documentation
    try:
        with open(doc_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading documentation file: {str(e)}"
        }
    
    # Check if content is not empty
    if len(content.strip()) < 50:
        return {
            "correct": False,
            "message": "Documentation file is too short or empty"
        }
    
    # Expected columns in users table based on seed.sql
    expected_columns = ['id', 'username', 'email', 'created_at']
    
    # Check if all expected columns are mentioned
    missing_columns = []
    for col in expected_columns:
        if col.lower() not in content.lower():
            missing_columns.append(col)
    
    if missing_columns:
        return {
            "correct": False,
            "message": f"Documentation is missing information about columns: {', '.join(missing_columns)}"
        }
    
    # Check for data type information
    has_type_info = any(keyword in content.lower() for keyword in 
                        ['serial', 'integer', 'varchar', 'text', 'timestamp', 'type', 'data type'])
    
    if not has_type_info:
        return {
            "correct": False,
            "message": "Documentation does not include data type information"
        }
    
    # Check for primary key mention
    has_pk_info = any(keyword in content.lower() for keyword in 
                      ['primary key', 'primary_key', 'pk', 'key'])
    
    if not has_pk_info:
        return {
            "correct": False,
            "message": "Documentation does not mention primary key information"
        }
    
    # Check for NULL/NOT NULL information
    has_null_info = any(keyword in content.lower() for keyword in 
                        ['null', 'not null', 'nullable'])
    
    if not has_null_info:
        return {
            "correct": False,
            "message": "Documentation does not include NULL constraint information"
        }
    
    return {
        "correct": True,
        "message": "Successfully created comprehensive documentation for the users table"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result["message"])
    exit(0 if result["correct"] else 1)