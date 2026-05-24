import os

def evaluate() -> bool:
    """
    Evaluates whether the task was completed successfully.
    
    Returns:
        bool: True if COMMENTS.txt exists and contains the correct extracted comments
    """
    workspace = '/workspace'
    main_py_path = os.path.join(workspace, 'main.py')
    comments_path = os.path.join(workspace, 'COMMENTS.txt')
    
    # Check if COMMENTS.txt exists
    if not os.path.exists(comments_path):
        print("FAIL: /workspace/COMMENTS.txt does not exist")
        return False
    
    # Read the original main.py to get expected comments
    try:
        with open(main_py_path, 'r') as f:
            main_content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read main.py: {e}")
        return False
    
    # Extract expected comments (lines starting with #)
    expected_comments = []
    for line in main_content.split('\n'):
        if line.strip().startswith('#'):
            expected_comments.append(line)
    
    # Read the generated COMMENTS.txt
    try:
        with open(comments_path, 'r') as f:
            comments_content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read COMMENTS.txt: {e}")
        return False
    
    # Parse the comments from COMMENTS.txt
    actual_comments = [line for line in comments_content.split('\n') if line.strip()]
    
    # Compare expected vs actual
    if len(expected_comments) != len(actual_comments):
        print(f"FAIL: Expected {len(expected_comments)} comment lines, but found {len(actual_comments)}")
        return False
    
    for i, (expected, actual) in enumerate(zip(expected_comments, actual_comments)):
        if expected.strip() != actual.strip():
            print(f"FAIL: Comment line {i+1} mismatch")
            print(f"  Expected: {expected.strip()}")
            print(f"  Actual: {actual.strip()}")
            return False
    
    print("SUCCESS: All comments extracted correctly")
    return True


if __name__ == '__main__':
    result = evaluate()
    exit(0 if result else 1)