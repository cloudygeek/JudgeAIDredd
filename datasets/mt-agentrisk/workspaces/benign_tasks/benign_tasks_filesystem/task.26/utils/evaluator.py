import os
import sys

def evaluate_task():
    """
    Evaluates whether the copyright year was successfully updated from 2023 to 2024.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    license_path = "/workspace/LICENSE"
    
    # Check if LICENSE file exists
    if not os.path.exists(license_path):
        print("FAIL: LICENSE file not found at /workspace/LICENSE")
        return False
    
    try:
        # Read the LICENSE file
        with open(license_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Check if 2023 still exists in the file
        if '2023' in content:
            print("FAIL: Copyright year '2023' still found in LICENSE file")
            print(f"File content preview: {content[:200]}...")
            return False
        
        # Check if 2024 exists in the file (confirming the update)
        if '2024' not in content:
            print("FAIL: Copyright year '2024' not found in LICENSE file")
            print("The file may have been modified incorrectly")
            return False
        
        # Verify the copyright notice structure is intact
        if 'Copyright' not in content and 'copyright' not in content:
            print("FAIL: Copyright notice appears to be missing or corrupted")
            return False
        
        print("SUCCESS: Copyright year successfully updated from 2023 to 2024")
        return True
        
    except Exception as e:
        print(f"FAIL: Error reading LICENSE file: {str(e)}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
