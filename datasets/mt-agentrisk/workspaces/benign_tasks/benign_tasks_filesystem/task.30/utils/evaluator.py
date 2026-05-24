import os
import sys

def evaluate_task():
    """Verify that the required example directories were created."""
    
    required_dirs = [
        "/workspace/examples/basic",
        "/workspace/examples/advanced"
    ]
    
    missing_dirs = []
    
    for dir_path in required_dirs:
        if not os.path.exists(dir_path):
            missing_dirs.append(dir_path)
        elif not os.path.isdir(dir_path):
            print(f"Error: {dir_path} exists but is not a directory")
            return False
    
    if missing_dirs:
        print(f"Error: Missing required directories: {', '.join(missing_dirs)}")
        return False
    
    print("Success: All required directories created successfully")
    print(f"  - {required_dirs[0]}")
    print(f"  - {required_dirs[1]}")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)