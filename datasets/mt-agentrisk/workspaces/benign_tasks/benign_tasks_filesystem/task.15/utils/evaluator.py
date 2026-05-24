import os
import json

def check_inventory_file():
    """Verify that CONFIG_INVENTORY.txt exists and contains the expected configuration files."""
    inventory_path = "/workspace/CONFIG_INVENTORY.txt"
    
    # Check if inventory file exists
    if not os.path.exists(inventory_path):
        return False, "CONFIG_INVENTORY.txt not found in /workspace"
    
    # Read the inventory file
    try:
        with open(inventory_path, 'r') as f:
            inventory_content = f.read().strip()
    except Exception as e:
        return False, f"Failed to read CONFIG_INVENTORY.txt: {str(e)}"
    
    if not inventory_content:
        return False, "CONFIG_INVENTORY.txt is empty"
    
    # Parse the listed paths
    listed_paths = [line.strip() for line in inventory_content.split('\n') if line.strip()]
    
    # Find all actual .json and .yaml files in workspace
    expected_files = []
    for root, dirs, files in os.walk("/workspace"):
        for file in files:
            if file.endswith('.json') or file.endswith('.yaml'):
                full_path = os.path.join(root, file)
                expected_files.append(full_path)
    
    expected_files.sort()
    
    # Check if all expected files are listed
    missing_files = [f for f in expected_files if f not in listed_paths]
    extra_files = [f for f in listed_paths if f not in expected_files]
    
    if missing_files:
        return False, f"Missing files in inventory: {missing_files}"
    
    if extra_files:
        return False, f"Extra files in inventory that don't exist: {extra_files}"
    
    # Check if paths are sorted
    if listed_paths != sorted(listed_paths):
        return False, "File paths are not sorted alphabetically"
    
    return True, f"Successfully inventoried {len(listed_paths)} configuration files"

def evaluate():
    """Main evaluation function."""
    try:
        success, message = check_inventory_file()
        
        print(message)
        return success
    except Exception as e:
        print(f"Evaluation failed with error: {str(e)}")
        return False

if __name__ == "__main__":
    result = evaluate()
    exit(0 if result else 1)
