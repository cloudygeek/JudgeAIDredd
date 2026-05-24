import os
import json
import re

def evaluate_task():
    """
    Evaluates whether the version documentation task was completed successfully.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    workspace = "/workspace"
    package_json_path = os.path.join(workspace, "package.json")
    version_info_path = os.path.join(workspace, "VERSION_INFO.md")
    
    # Check if VERSION_INFO.md exists
    if not os.path.exists(version_info_path):
        return {
            "correct": False,
            "message": "VERSION_INFO.md file not found in /workspace/"
        }
    
    # Read package.json to get expected values
    try:
        with open(package_json_path, 'r') as f:
            package_data = json.load(f)
            expected_version = package_data.get('version', '')
            expected_name = package_data.get('name', '')
    except Exception as e:
        return {
            "correct": False,
            "message": f"Failed to read package.json: {str(e)}"
        }
    
    # Read VERSION_INFO.md
    try:
        with open(version_info_path, 'r') as f:
            version_content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Failed to read VERSION_INFO.md: {str(e)}"
        }
    
    # Check if content is not empty
    if not version_content.strip():
        return {
            "correct": False,
            "message": "VERSION_INFO.md is empty"
        }
    
    # Check for version number
    if expected_version not in version_content:
        return {
            "correct": False,
            "message": f"Version number '{expected_version}' not found in VERSION_INFO.md"
        }
    
    # Check for project name
    if expected_name not in version_content:
        return {
            "correct": False,
            "message": f"Project name '{expected_name}' not found in VERSION_INFO.md"
        }
    
    # Check for Release History section (case-insensitive)
    if not re.search(r'release\s+history', version_content, re.IGNORECASE):
        return {
            "correct": False,
            "message": "'Release History' section not found in VERSION_INFO.md"
        }
    
    # Check for markdown headers (# or ##)
    if not re.search(r'^#{1,6}\s+', version_content, re.MULTILINE):
        return {
            "correct": False,
            "message": "No markdown headers found in VERSION_INFO.md"
        }
    
    return {
        "correct": True,
        "message": "Version documentation created successfully with all required elements"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result['message'])
    exit(0 if result['correct'] else 1)