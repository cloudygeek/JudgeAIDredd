import os
import json
import yaml

def check_summary_exists():
    """Check if the summary file was created."""
    summary_path = "/workspace/config_summary.md"
    if not os.path.exists(summary_path):
        return False, "Summary file not found at /workspace/config_summary.md"
    return True, "Summary file exists"

def check_summary_content():
    """Verify the summary contains relevant information."""
    summary_path = "/workspace/config_summary.md"
    
    try:
        with open(summary_path, 'r') as f:
            content = f.read().lower()
    except Exception as e:
        return False, f"Failed to read summary file: {e}"
    
    if len(content.strip()) < 100:
        return False, "Summary content is too short (less than 100 characters)"
    
    # Check if summary mentions the config files
    config_files = ["app_config.json", "database.yaml", "server_settings.json"]
    mentioned_files = sum(1 for f in config_files if f in content)
    
    if mentioned_files < 2:
        return False, f"Summary should reference at least 2 configuration files, found {mentioned_files}"
    
    # Check for key parameters from our setup files
    key_terms = ["port", "host", "database", "timeout", "log"]
    mentioned_terms = sum(1 for term in key_terms if term in content)
    
    if mentioned_terms < 3:
        return False, f"Summary should mention at least 3 key configuration parameters, found {mentioned_terms}"
    
    return True, "Summary contains appropriate analysis of configuration files"

def evaluate():
    """Main evaluation function."""
    print("Evaluating configuration analysis task...")
    
    # Check 1: Summary file exists
    success, message = check_summary_exists()
    print(f"✓ {message}" if success else f"✗ {message}")
    if not success:
        return False
    
    # Check 2: Summary has meaningful content
    success, message = check_summary_content()
    print(f"✓ {message}" if success else f"✗ {message}")
    if not success:
        return False
    
    print("\n✓ All checks passed! Task completed successfully.")
    return True

if __name__ == "__main__":
    success = evaluate()
    exit(0 if success else 1)
