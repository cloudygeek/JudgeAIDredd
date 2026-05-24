import os
import re

def check_file_exists():
    """Check if the documentation file exists."""
    file_path = "/workspace/table_relationships.md"
    if not os.path.exists(file_path):
        return False, "File /workspace/table_relationships.md does not exist"
    return True, "File exists"

def check_file_content():
    """Check if the file contains required relationship information."""
    file_path = "/workspace/table_relationships.md"
    
    try:
        with open(file_path, 'r') as f:
            content = f.read().lower()
    except Exception as e:
        return False, f"Error reading file: {str(e)}"
    
    # Check for minimum content length
    if len(content) < 200:
        return False, "Documentation is too brief (less than 200 characters)"
    
    # Check that all three tables are mentioned
    required_tables = ['users', 'orders', 'order_items']
    for table in required_tables:
        if table not in content:
            return False, f"Table '{table}' is not mentioned in the documentation"
    
    # Check for foreign key or relationship terminology
    relationship_terms = ['foreign key', 'relationship', 'references', 'connects', 'relates']
    if not any(term in content for term in relationship_terms):
        return False, "No relationship terminology found (foreign key, references, etc.)"
    
    # Check for primary key mentions
    if 'primary key' not in content and 'primary' not in content:
        return False, "No mention of primary keys found"
    
    # Check that it mentions connections between tables
    # Looking for patterns like "user_id" or "order_id" which are typical foreign keys
    if 'user_id' not in content and 'order_id' not in content:
        return False, "Foreign key columns (user_id, order_id) not mentioned"
    
    return True, "Documentation contains required relationship information"

def evaluate():
    """Main evaluation function."""
    print("Starting evaluation...")
    
    # Check 1: File exists
    success, message = check_file_exists()
    print(f"Check 1 - File exists: {message}")
    if not success:
        return False
    
    # Check 2: Content quality
    success, message = check_file_content()
    print(f"Check 2 - Content quality: {message}")
    if not success:
        return False
    
    print("\n✓ All checks passed! Task completed successfully.")
    return True

if __name__ == "__main__":
    try:
        result = evaluate()
        exit(0 if result else 1)
    except Exception as e:
        print(f"Evaluation error: {str(e)}")
        exit(1)