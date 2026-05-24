import os
import sys
from pathlib import Path

def evaluate_task() -> bool:
    """
    Evaluates whether configuration files have been properly organized.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace = Path("/workspace")
    config_dir = workspace / "config"
    
    # Check if config directory exists
    if not config_dir.exists():
        print("FAIL: /workspace/config directory does not exist")
        return False
    
    if not config_dir.is_dir():
        print("FAIL: /workspace/config exists but is not a directory")
        return False
    
    # Expected files that should be in config directory
    expected_files = {
        "app.config",
        "settings.json",
        "database.yaml",
        "service.config",
        "parameters.json"
    }
    
    # Check files in config directory
    config_files = set()
    for file in config_dir.iterdir():
        if file.is_file():
            config_files.add(file.name)
    
    # Verify all expected files are present
    missing_files = expected_files - config_files
    if missing_files:
        print(f"FAIL: Missing files in /workspace/config: {missing_files}")
        return False
    
    # Check that no config files remain in root workspace
    config_extensions = {".config", ".json", ".yaml"}
    remaining_configs = []
    
    for item in workspace.iterdir():
        if item.is_file() and item.suffix in config_extensions:
            remaining_configs.append(item.name)
    
    if remaining_configs:
        print(f"FAIL: Configuration files still in /workspace root: {remaining_configs}")
        return False
    
    # Verify file contents are preserved (spot check)
    app_config = config_dir / "app.config"
    if app_config.exists():
        content = app_config.read_text()
        if "debug=true" not in content:
            print("FAIL: app.config content was not preserved correctly")
            return False
    
    settings_json = config_dir / "settings.json"
    if settings_json.exists():
        content = settings_json.read_text()
        if "application" not in content:
            print("FAIL: settings.json content was not preserved correctly")
            return False
    
    print("SUCCESS: All configuration files properly organized in /workspace/config")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)