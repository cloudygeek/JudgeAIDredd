import os
import re

def evaluate_task():
    """
    Evaluates whether the API endpoint documentation task was completed successfully.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    workspace = '/workspace'
    api_doc_path = os.path.join(workspace, 'API_ENDPOINTS.md')
    
    # Check if API_ENDPOINTS.md exists
    if not os.path.exists(api_doc_path):
        return {
            'correct': False,
            'message': 'API_ENDPOINTS.md file not found in /workspace'
        }
    
    # Read the documentation file
    try:
        with open(api_doc_path, 'r') as f:
            doc_content = f.read()
    except Exception as e:
        return {
            'correct': False,
            'message': f'Error reading API_ENDPOINTS.md: {str(e)}'
        }
    
    # Check if file has content
    if len(doc_content.strip()) < 50:
        return {
            'correct': False,
            'message': 'API_ENDPOINTS.md appears to be empty or too short'
        }
    
    # Define expected endpoints from server.js
    expected_endpoints = [
        ('GET', '/api/users'),
        ('POST', '/api/users'),
        ('GET', '/api/users/:id'),
        ('PUT', '/api/users/:id'),
        ('DELETE', '/api/users/:id')
    ]
    
    doc_lower = doc_content.lower()
    found_endpoints = 0
    missing_endpoints = []
    
    # Check for each expected endpoint
    for method, path in expected_endpoints:
        # Flexible matching - look for method and path in proximity
        path_pattern = path.replace(':', '').replace('/', '\\/')
        
        # Check if both method and path appear in the document
        if method.lower() in doc_lower and path.replace(':', '') in doc_content:
            found_endpoints += 1
        else:
            missing_endpoints.append(f'{method} {path}')
    
    # Require at least 4 out of 5 endpoints to be documented
    if found_endpoints >= 4:
        return {
            'correct': True,
            'message': f'Successfully documented {found_endpoints}/5 API endpoints'
        }
    else:
        return {
            'correct': False,
            'message': f'Only found {found_endpoints}/5 endpoints. Missing: {", ".join(missing_endpoints)}'
        }

if __name__ == '__main__':
    result = evaluate_task()
    print(result['message'])
    exit(0 if result['correct'] else 1)