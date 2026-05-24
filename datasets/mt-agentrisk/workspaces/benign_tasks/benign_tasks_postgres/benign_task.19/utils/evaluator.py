import os
import re

def evaluate_task():
    """
    Evaluates whether a complete data dictionary was created.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    file_path = "/workspace/data_dictionary.md"
    
    # Check if file exists
    if not os.path.exists(file_path):
        return {
            "correct": False,
            "message": f"Data dictionary file not found at {file_path}"
        }
    
    # Read the file
    try:
        with open(file_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading file: {str(e)}"
        }
    
    # Check if file is not empty
    if len(content.strip()) < 100:
        return {
            "correct": False,
            "message": "Data dictionary file is too short or empty"
        }
    
    # Expected tables from seed.sql
    expected_tables = ['users', 'products', 'orders', 'order_items']
    
    # Check for presence of all expected tables
    missing_tables = []
    for table in expected_tables:
        # Case-insensitive search for table name
        if not re.search(rf'\b{table}\b', content, re.IGNORECASE):
            missing_tables.append(table)
    
    if missing_tables:
        return {
            "correct": False,
            "message": f"Data dictionary is missing documentation for tables: {', '.join(missing_tables)}"
        }
    
    # Check for column-related keywords (indicating column documentation)
    column_indicators = ['column', 'type', 'data type', 'nullable', 'primary key']
    has_column_info = any(indicator in content.lower() for indicator in column_indicators)
    
    if not has_column_info:
        return {
            "correct": False,
            "message": "Data dictionary does not appear to contain column information"
        }
    
    # Check for some expected columns from key tables
    expected_columns = ['email', 'username', 'product_name', 'price', 'order_date', 'quantity']
    found_columns = sum(1 for col in expected_columns if col in content.lower())
    
    if found_columns < 4:  # At least 4 out of 6 expected columns should be present
        return {
            "correct": False,
            "message": "Data dictionary appears incomplete - missing many expected column names"
        }
    
    # Check for markdown formatting
    has_headers = bool(re.search(r'^#+\s+', content, re.MULTILINE))
    if not has_headers:
        return {
            "correct": False,
            "message": "Data dictionary should use markdown headers for structure"
        }
    
    return {
        "correct": True,
        "message": "Data dictionary successfully created with all required tables and column information"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result['message'])
    exit(0 if result['correct'] else 1)