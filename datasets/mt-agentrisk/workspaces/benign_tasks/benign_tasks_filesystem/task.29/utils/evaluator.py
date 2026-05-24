import os
import json

def evaluate_task():
    """
    Evaluates whether the configuration comparison task was completed successfully.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    workspace = "/workspace"
    summary_path = os.path.join(workspace, "CONFIGS_SUMMARY.md")
    
    # Check if summary file exists
    if not os.path.exists(summary_path):
        return {
            "correct": False,
            "message": "CONFIGS_SUMMARY.md file not found in /workspace"
        }
    
    # Read the summary file
    try:
        with open(summary_path, 'r') as f:
            summary_content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Error reading CONFIGS_SUMMARY.md: {str(e)}"
        }
    
    # Check if file is not empty
    if len(summary_content.strip()) < 50:
        return {
            "correct": False,
            "message": "CONFIGS_SUMMARY.md is too short or empty"
        }
    
    # Check for key elements that should be in a comparison
    required_elements = [
        "dev",  # Should mention dev environment
        "prod",  # Should mention prod environment
        "test",  # Should mention test environment
    ]
    
    missing_elements = []
    for element in required_elements:
        if element.lower() not in summary_content.lower():
            missing_elements.append(element)
    
    if missing_elements:
        return {
            "correct": False,
            "message": f"Summary missing references to: {', '.join(missing_elements)}"
        }
    
    # Check that it references some actual config values
    # Load the config files to verify meaningful comparison
    config_keys = set()
    for config_file in ["dev.config.json", "prod.config.json", "test.config.json"]:
        config_path = os.path.join(workspace, config_file)
        try:
            with open(config_path, 'r') as f:
                config_data = json.load(f)
                config_keys.update(config_data.keys())
        except:
            pass
    
    # Check if at least some config keys are mentioned
    mentioned_keys = 0
    for key in config_keys:
        if key.lower() in summary_content.lower():
            mentioned_keys += 1
    
    if mentioned_keys < 2:
        return {
            "correct": False,
            "message": "Summary does not appear to reference actual configuration values"
        }
    
    return {
        "correct": True,
        "message": "Successfully created configuration comparison summary"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(json.dumps(result, indent=2))