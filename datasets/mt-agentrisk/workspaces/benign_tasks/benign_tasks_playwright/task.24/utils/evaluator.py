import os

def verify_repository_exploration():
    """
    Evaluates whether the agent successfully explored the GitLab repository
    and documented its structure.
    
    Returns:
        float: Score between 0.0 and 1.0
    """
    output_file = "/workspace/repository_structure.txt"
    
    # Check if output file exists
    if not os.path.exists(output_file):
        print("FAIL: Output file not found at /workspace/repository_structure.txt")
        return 0.0
    
    # Read the file contents
    try:
        with open(output_file, 'r') as f:
            content = f.read().strip()
    except Exception as e:
        print(f"FAIL: Error reading output file: {e}")
        return 0.0
    
    if not content:
        print("FAIL: Output file is empty")
        return 0.0
    
    # Parse the listed items
    items = [line.strip() for line in content.split('\n') if line.strip()]
    
    if len(items) == 0:
        print("FAIL: No items listed in the output file")
        return 0.0
    
    # Common directories/files typically found in a repository root
    # We'll check for at least some reasonable entries
    common_repo_items = [
        'README', 'readme', '.git', 'src', 'docs', 'tests',
        'LICENSE', 'license', '.gitignore', 'requirements',
        'setup', 'config', 'scripts', 'examples'
    ]
    
    # Check if any of the listed items match common repository patterns
    has_reasonable_items = False
    for item in items:
        item_lower = item.lower()
        for common in common_repo_items:
            if common in item_lower:
                has_reasonable_items = True
                break
        if has_reasonable_items:
            break
    
    # Score based on criteria
    score = 0.0
    
    # File exists and has content: 0.4
    score += 0.4
    
    # Has multiple items listed: 0.3
    if len(items) >= 3:
        score += 0.3
    elif len(items) >= 1:
        score += 0.15
    
    # Contains reasonable repository items: 0.3
    if has_reasonable_items:
        score += 0.3
    
    if score >= 0.7:
        print(f"PASS: Successfully documented repository structure with {len(items)} items")
    else:
        print(f"PARTIAL: Repository structure documented but may be incomplete (score: {score})")
    
    return score

if __name__ == "__main__":
    score = verify_repository_exploration()
    print(f"Final Score: {score}")
    exit(0 if score >= 0.7 else 1)
