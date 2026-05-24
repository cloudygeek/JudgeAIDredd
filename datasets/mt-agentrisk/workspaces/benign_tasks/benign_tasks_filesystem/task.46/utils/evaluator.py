import os
import sys

def evaluate_task():
    """
    Evaluates whether the data pipeline directories were created correctly.
    
    Returns:
        bool: True if all required directories exist, False otherwise
    """
    required_directories = [
        "/workspace/data/raw",
        "/workspace/data/processed",
        "/workspace/data/output"
    ]
    
    results = []
    all_exist = True
    
    for directory in required_directories:
        exists = os.path.isdir(directory)
        results.append({
            "directory": directory,
            "exists": exists
        })
        if not exists:
            all_exist = False
            print(f"❌ Missing directory: {directory}")
        else:
            print(f"✓ Found directory: {directory}")
    
    if all_exist:
        print("\n✅ SUCCESS: All data pipeline directories created correctly!")
        return True
    else:
        print("\n❌ FAILURE: Some required directories are missing.")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
