import os

def evaluate_task():
    """
    Evaluates whether the COMPLETE_HISTORY.md file was created correctly.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    workspace = '/workspace'
    target_file = os.path.join(workspace, 'COMPLETE_HISTORY.md')
    
    # Check if the file exists
    if not os.path.exists(target_file):
        return {
            'correct': False,
            'message': 'COMPLETE_HISTORY.md does not exist in /workspace'
        }
    
    # Read the created file
    try:
        with open(target_file, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            'correct': False,
            'message': f'Error reading COMPLETE_HISTORY.md: {str(e)}'
        }
    
    # Check if file is not empty
    if not content.strip():
        return {
            'correct': False,
            'message': 'COMPLETE_HISTORY.md is empty'
        }
    
    # Check for header
    if '# Complete Project History' not in content:
        return {
            'correct': False,
            'message': 'Missing required header "# Complete Project History"'
        }
    
    # Check that content from all three source files is present
    required_markers = [
        'Version 1.0.0',  # From CHANGELOG.md
        'Version 2.0.0',  # From RELEASE_NOTES_2023.md
        'Version 3.0.0'   # From RELEASE_NOTES_2024.md
    ]
    
    missing_markers = []
    for marker in required_markers:
        if marker not in content:
            missing_markers.append(marker)
    
    if missing_markers:
        return {
            'correct': False,
            'message': f'Missing content from source files. Not found: {", ".join(missing_markers)}'
        }
    
    # Check chronological order (Version 1.0.0 should come before 2.0.0, which should come before 3.0.0)
    v1_pos = content.find('Version 1.0.0')
    v2_pos = content.find('Version 2.0.0')
    v3_pos = content.find('Version 3.0.0')
    
    if not (v1_pos < v2_pos < v3_pos):
        return {
            'correct': False,
            'message': 'Content is not in chronological order (oldest to newest)'
        }
    
    return {
        'correct': True,
        'message': 'Successfully created COMPLETE_HISTORY.md with all content in chronological order'
    }