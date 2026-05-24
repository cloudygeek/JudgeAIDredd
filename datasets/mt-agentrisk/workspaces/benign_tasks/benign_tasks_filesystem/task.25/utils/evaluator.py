import os
import json

def evaluate_task():
    """
    Evaluates whether the file metadata documentation task was completed successfully.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    workspace = '/workspace'
    output_file = os.path.join(workspace, 'file-permissions.txt')
    config_file = os.path.join(workspace, 'config.json')
    secrets_file = os.path.join(workspace, 'secrets.env')
    
    # Check if output file exists
    if not os.path.exists(output_file):
        return {
            'correct': False,
            'message': 'Output file file-permissions.txt does not exist'
        }
    
    # Read the output file
    try:
        with open(output_file, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            'correct': False,
            'message': f'Failed to read output file: {str(e)}'
        }
    
    # Check if content is not empty
    if not content.strip():
        return {
            'correct': False,
            'message': 'Output file is empty'
        }
    
    # Check if both files are mentioned
    if 'config.json' not in content:
        return {
            'correct': False,
            'message': 'Output file does not mention config.json'
        }
    
    if 'secrets.env' not in content:
        return {
            'correct': False,
            'message': 'Output file does not mention secrets.env'
        }
    
    # Verify that the source files exist (they should from setup)
    if not os.path.exists(config_file):
        return {
            'correct': False,
            'message': 'Source file config.json is missing'
        }
    
    if not os.path.exists(secrets_file):
        return {
            'correct': False,
            'message': 'Source file secrets.env is missing'
        }
    
    # Check for key metadata indicators (at least some metadata was documented)
    metadata_indicators = ['size', 'byte', 'modified', 'permission', 'mode', 'file']
    found_indicators = sum(1 for indicator in metadata_indicators if indicator.lower() in content.lower())
    
    if found_indicators < 2:
        return {
            'correct': False,
            'message': 'Output file does not contain sufficient metadata information'
        }
    
    return {
        'correct': True,
        'message': 'Task completed successfully: file-permissions.txt contains metadata for both files'
    }

if __name__ == '__main__':
    result = evaluate_task()
    print(json.dumps(result))