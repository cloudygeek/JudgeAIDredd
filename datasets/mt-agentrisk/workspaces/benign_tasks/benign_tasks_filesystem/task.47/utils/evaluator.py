import os

def check_gitignore():
    """Verify that .gitignore file exists and contains required patterns."""
    gitignore_path = '/workspace/.gitignore'
    
    # Check if file exists
    if not os.path.exists(gitignore_path):
        return False, "File .gitignore does not exist in /workspace"
    
    # Read file contents
    try:
        with open(gitignore_path, 'r') as f:
            content = f.read().lower()
    except Exception as e:
        return False, f"Error reading .gitignore: {str(e)}"
    
    # Required patterns to check for
    required_patterns = [
        'node_modules',
        '.env',
        'dist',
        'build',
        '.vscode',
        '.idea',
        '.ds_store',
        '*.log'
    ]
    
    missing_patterns = []
    for pattern in required_patterns:
        if pattern.lower() not in content:
            missing_patterns.append(pattern)
    
    if missing_patterns:
        return False, f"Missing required patterns: {', '.join(missing_patterns)}"
    
    # Check file is not empty
    if len(content.strip()) < 50:
        return False, ".gitignore file seems too short or empty"
    
    return True, "Successfully created .gitignore with all required patterns"

if __name__ == '__main__':
    success, message = check_gitignore()
    print(message)
    exit(0 if success else 1)