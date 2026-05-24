import os
import json

def evaluate_task():
    """
    Evaluates whether the workspace inventory task was completed successfully.
    
    Returns:
        dict: Result with 'correct' boolean and 'message' string
    """
    inventory_path = "/workspace/INVENTORY.txt"
    
    # Check if INVENTORY.txt exists
    if not os.path.exists(inventory_path):
        return {
            "correct": False,
            "message": "INVENTORY.txt does not exist in /workspace"
        }
    
    # Read the inventory file
    try:
        with open(inventory_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return {
            "correct": False,
            "message": f"Failed to read INVENTORY.txt: {str(e)}"
        }
    
    # Check if file is not empty
    if len(content.strip()) == 0:
        return {
            "correct": False,
            "message": "INVENTORY.txt is empty"
        }
    
    # Check for directory tree indicators (common tree symbols)
    has_tree_structure = any(indicator in content for indicator in ['├──', '└──', '│', '/workspace'])
    
    if not has_tree_structure:
        return {
            "correct": False,
            "message": "INVENTORY.txt does not contain a directory tree structure"
        }
    
    # Check for file size information (looking for common size patterns)
    # Sizes typically shown as numbers followed by B, KB, MB, or just bytes
    has_size_info = any(indicator in content for indicator in [' bytes', 'B', 'KB', 'MB', 'size'])
    
    if not has_size_info:
        return {
            "correct": False,
            "message": "INVENTORY.txt does not contain file size information"
        }
    
    # Verify some of the setup files are mentioned
    setup_files = ['project.json', 'README.md', 'main.py', 'config.yaml']
    mentioned_files = sum(1 for f in setup_files if f in content)
    
    if mentioned_files < 2:
        return {
            "correct": False,
            "message": "INVENTORY.txt does not appear to contain information about workspace files"
        }
    
    # Check minimum content length (should be substantial)
    if len(content) < 200:
        return {
            "correct": False,
            "message": "INVENTORY.txt appears incomplete (too short)"
        }
    
    return {
        "correct": True,
        "message": "Successfully created workspace inventory with directory tree and file sizes"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(json.dumps(result))