import os

def evaluate_task():
    """
    Evaluates whether the database schemas have been successfully listed.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    schemas_file = "/workspace/schemas.txt"
    
    # Check if the file exists
    if not os.path.exists(schemas_file):
        return False, "schemas.txt file not found at /workspace/schemas.txt", 0.0
    
    # Read the file contents
    try:
        with open(schemas_file, 'r') as f:
            content = f.read().strip()
    except Exception as e:
        return False, f"Error reading schemas.txt: {str(e)}", 0.0
    
    if not content:
        return False, "schemas.txt is empty", 0.0
    
    # Parse schema names
    schema_lines = [line.strip() for line in content.split('\n') if line.strip()]
    
    if len(schema_lines) == 0:
        return False, "No schema names found in schemas.txt", 0.0
    
    # Expected schemas based on PostgreSQL defaults + seed data
    # PostgreSQL typically has: public, information_schema, pg_catalog, pg_toast
    # We'll check for at least 'public' and 'information_schema'
    expected_schemas = {'public', 'information_schema'}
    found_schemas = set(schema_lines)
    
    # Check if expected schemas are present
    missing_schemas = expected_schemas - found_schemas
    if missing_schemas:
        return False, f"Missing expected schemas: {', '.join(missing_schemas)}", 0.5
    
    # Check if schemas are sorted alphabetically
    sorted_schemas = sorted(schema_lines)
    if schema_lines != sorted_schemas:
        return False, "Schema names are not sorted alphabetically", 0.7
    
    # Success
    feedback = f"Successfully listed {len(schema_lines)} schemas in alphabetical order"
    return True, feedback, 1.0


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Feedback: {feedback}")
    print(f"Score: {score}")