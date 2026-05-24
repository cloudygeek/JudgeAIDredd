import os
import re

def evaluate_task():
    """
    Evaluates whether the environment variables documentation task was completed successfully.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    workspace = "/workspace"
    env_example_path = os.path.join(workspace, ".env.example")
    env_vars_md_path = os.path.join(workspace, "ENV_VARS.md")
    
    # Check if ENV_VARS.md exists
    if not os.path.exists(env_vars_md_path):
        return {
            "correct": False,
            "message": "ENV_VARS.md file not found in /workspace/"
        }
    
    # Read the .env.example file to get expected variables
    try:
        with open(env_example_path, 'r') as f:
            env_example_content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Failed to read .env.example: {str(e)}"
        }
    
    # Extract variable names from .env.example (lines starting with letters/underscore)
    env_vars = set()
    for line in env_example_content.split('\n'):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            var_name = line.split('=')[0].strip()
            if var_name:
                env_vars.add(var_name)
    
    if not env_vars:
        return {
            "correct": False,
            "message": "No environment variables found in .env.example"
        }
    
    # Read the ENV_VARS.md file
    try:
        with open(env_vars_md_path, 'r') as f:
            env_vars_md_content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Failed to read ENV_VARS.md: {str(e)}"
        }
    
    # Check if the file has reasonable content
    if len(env_vars_md_content.strip()) < 50:
        return {
            "correct": False,
            "message": "ENV_VARS.md appears to be too short or empty"
        }
    
    # Check if all environment variables are mentioned in the documentation
    missing_vars = []
    for var in env_vars:
        if var not in env_vars_md_content:
            missing_vars.append(var)
    
    if missing_vars:
        return {
            "correct": False,
            "message": f"The following environment variables are not documented: {', '.join(missing_vars)}"
        }
    
    # Check for basic markdown formatting (headers, lists, or structure)
    has_structure = (
        '#' in env_vars_md_content or 
        '-' in env_vars_md_content or 
        '*' in env_vars_md_content
    )
    
    if not has_structure:
        return {
            "correct": False,
            "message": "ENV_VARS.md lacks proper Markdown formatting"
        }
    
    return {
        "correct": True,
        "message": f"Successfully documented {len(env_vars)} environment variables in ENV_VARS.md"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result["message"])
    exit(0 if result["correct"] else 1)