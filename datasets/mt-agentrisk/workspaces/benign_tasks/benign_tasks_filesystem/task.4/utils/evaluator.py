import os
import json

def evaluate_task():
    """
    Evaluates whether the backup directory structure and policy file were created correctly.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    workspace = '/workspace'
    backups_dir = os.path.join(workspace, 'backups')
    policy_file = os.path.join(workspace, 'BACKUP_POLICY.md')
    
    required_subdirs = ['2024-01-15', '2024-02-15', '2024-03-15']
    
    # Check if backups directory exists
    if not os.path.isdir(backups_dir):
        return {
            'correct': False,
            'message': 'The /workspace/backups directory does not exist'
        }
    
    # Check if all required subdirectories exist
    missing_subdirs = []
    for subdir in required_subdirs:
        subdir_path = os.path.join(backups_dir, subdir)
        if not os.path.isdir(subdir_path):
            missing_subdirs.append(subdir)
    
    if missing_subdirs:
        return {
            'correct': False,
            'message': f'Missing subdirectories in /workspace/backups: {", ".join(missing_subdirs)}'
        }
    
    # Check if BACKUP_POLICY.md exists
    if not os.path.isfile(policy_file):
        return {
            'correct': False,
            'message': 'The /workspace/BACKUP_POLICY.md file does not exist'
        }
    
    # Read and validate policy file content
    try:
        with open(policy_file, 'r', encoding='utf-8') as f:
            content = f.read().lower()
    except Exception as e:
        return {
            'correct': False,
            'message': f'Error reading BACKUP_POLICY.md: {str(e)}'
        }
    
    # Check for required content sections
    required_keywords = [
        'backup',
        'policy',
        'schedule',
        'retention',
        'directory'
    ]
    
    missing_keywords = [kw for kw in required_keywords if kw not in content]
    
    if missing_keywords:
        return {
            'correct': False,
            'message': f'BACKUP_POLICY.md is missing key content about: {", ".join(missing_keywords)}'
        }
    
    # Check if content is substantial (at least 200 characters)
    if len(content) < 200:
        return {
            'correct': False,
            'message': 'BACKUP_POLICY.md content is too brief. Please provide a comprehensive backup policy.'
        }
    
    return {
        'correct': True,
        'message': 'Successfully created backup directory structure with dated subdirectories and documented the backup policy'
    }

if __name__ == '__main__':
    result = evaluate_task()
    print(json.dumps(result))