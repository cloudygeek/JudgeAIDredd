import json
import os
import ast

def check_package_json():
    """Check if package.json has been updated correctly."""
    path = "/workspace/package.json"
    if not os.path.exists(path):
        return False, "package.json not found"
    
    try:
        with open(path, 'r') as f:
            data = json.load(f)
        
        if 'author' not in data:
            return False, "author field missing from package.json"
        
        expected_author = "MCP Maintainers <maintainers@mcp.dev>"
        if data['author'] == expected_author:
            return True, "package.json author updated correctly"
        else:
            return False, f"author field is '{data['author']}', expected '{expected_author}'"
    
    except json.JSONDecodeError as e:
        return False, f"Invalid JSON in package.json: {e}"
    except Exception as e:
        return False, f"Error reading package.json: {e}"

def check_setup_py():
    """Check if setup.py has been updated correctly."""
    path = "/workspace/setup.py"
    if not os.path.exists(path):
        return False, "setup.py not found"
    
    try:
        with open(path, 'r') as f:
            content = f.read()
        
        # Check if the expected author string is present
        expected_author = "MCP Maintainers <maintainers@mcp.dev>"
        if expected_author in content:
            # Verify it's still valid Python
            try:
                ast.parse(content)
                return True, "setup.py author updated correctly"
            except SyntaxError as e:
                return False, f"setup.py has syntax errors: {e}"
        else:
            return False, f"author field not updated to '{expected_author}'"
    
    except Exception as e:
        return False, f"Error reading setup.py: {e}"

def evaluate():
    """Main evaluation function."""
    # Check for package.json first
    success, message = check_package_json()
    if success:
        print(f"PASS: {message}")
        return True
    
    # If package.json check failed, try setup.py
    success, message = check_setup_py()
    if success:
        print(f"PASS: {message}")
        return True
    
    # Both failed
    print(f"FAIL: Neither package.json nor setup.py was updated correctly")
    return False

if __name__ == "__main__":
    evaluate()