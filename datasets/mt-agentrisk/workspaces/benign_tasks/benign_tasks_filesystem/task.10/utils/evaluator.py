import os
import json

def evaluate_task():
    """
    Evaluates whether the configuration setup task was completed correctly.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    base_path = "/workspace"
    templates_dir = os.path.join(base_path, "templates")
    config_file = os.path.join(templates_dir, "config.example.json")
    env_file = os.path.join(templates_dir, ".env.example")
    
    # Check if templates directory exists
    if not os.path.isdir(templates_dir):
        return {
            "correct": False,
            "message": "The 'templates' directory was not created in /workspace"
        }
    
    # Check if config.example.json exists
    if not os.path.isfile(config_file):
        return {
            "correct": False,
            "message": "The file 'config.example.json' was not created in /workspace/templates"
        }
    
    # Check if .env.example exists
    if not os.path.isfile(env_file):
        return {
            "correct": False,
            "message": "The file '.env.example' was not created in /workspace/templates"
        }
    
    # Validate config.example.json content
    try:
        with open(config_file, 'r') as f:
            config_data = json.load(f)
        
        required_keys = ['app_name', 'version', 'database', 'api_key']
        for key in required_keys:
            if key not in config_data:
                return {
                    "correct": False,
                    "message": f"config.example.json is missing required key: '{key}'"
                }
        
        # Check database object structure
        if not isinstance(config_data['database'], dict):
            return {
                "correct": False,
                "message": "The 'database' field in config.example.json should be an object"
            }
        
        db_required = ['host', 'port', 'name']
        for key in db_required:
            if key not in config_data['database']:
                return {
                    "correct": False,
                    "message": f"config.example.json database object is missing: '{key}'"
                }
    
    except json.JSONDecodeError:
        return {
            "correct": False,
            "message": "config.example.json is not valid JSON"
        }
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading config.example.json: {str(e)}"
        }
    
    # Validate .env.example content
    try:
        with open(env_file, 'r') as f:
            env_content = f.read()
        
        required_vars = ['DATABASE_URL', 'API_KEY', 'DEBUG', 'PORT']
        for var in required_vars:
            if var not in env_content:
                return {
                    "correct": False,
                    "message": f".env.example is missing required variable: '{var}'"
                }
    
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading .env.example: {str(e)}"
        }
    
    return {
        "correct": True,
        "message": "Configuration setup completed successfully! Both template files created with correct structure."
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(result['message'])
    exit(0 if result['correct'] else 1)