import json
import os
import re

def evaluate_task():
    """
    Evaluates whether the CONFIG_SCHEMA.md file correctly documents
    the structure of config.json.
    """
    workspace = "/workspace"
    config_path = os.path.join(workspace, "config.json")
    schema_path = os.path.join(workspace, "CONFIG_SCHEMA.md")
    
    # Check if CONFIG_SCHEMA.md exists
    if not os.path.exists(schema_path):
        return False, "CONFIG_SCHEMA.md file not found in /workspace/"
    
    # Read the original config.json
    try:
        with open(config_path, 'r') as f:
            config_data = json.load(f)
    except Exception as e:
        return False, f"Failed to read config.json: {str(e)}"
    
    # Read the generated schema documentation
    try:
        with open(schema_path, 'r') as f:
            schema_content = f.read()
    except Exception as e:
        return False, f"Failed to read CONFIG_SCHEMA.md: {str(e)}"
    
    # Verify schema_content is not empty
    if not schema_content.strip():
        return False, "CONFIG_SCHEMA.md is empty"
    
    # Get all top-level keys from config.json
    top_level_keys = list(config_data.keys())
    
    if not top_level_keys:
        return False, "config.json has no top-level keys"
    
    # Check that all top-level keys are mentioned in the schema
    missing_keys = []
    for key in top_level_keys:
        # Case-insensitive search for the key name
        if key.lower() not in schema_content.lower():
            missing_keys.append(key)
    
    if missing_keys:
        return False, f"Missing documentation for keys: {', '.join(missing_keys)}"
    
    # Verify that data types are mentioned for keys
    # Common type keywords to look for
    type_keywords = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'list', 'dict']
    has_type_info = any(keyword in schema_content.lower() for keyword in type_keywords)
    
    if not has_type_info:
        return False, "Schema documentation does not include data type information"
    
    # Check for basic markdown formatting (headers)
    if not re.search(r'^#', schema_content, re.MULTILINE):
        return False, "CONFIG_SCHEMA.md does not appear to be formatted as markdown (no headers found)"
    
    return True, "Task completed successfully: CONFIG_SCHEMA.md correctly documents the configuration structure"


if __name__ == "__main__":
    success, message = evaluate_task()
    print(message)
    exit(0 if success else 1)