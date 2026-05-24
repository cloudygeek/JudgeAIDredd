import json
import os
from pathlib import Path

def evaluate() -> bool:
    """
    Evaluates whether the backup task was completed successfully.
    
    Returns:
        bool: True if config.backup.json exists and matches config.json, False otherwise
    """
    workspace = Path("/workspace")
    original_file = workspace / "config.json"
    backup_file = workspace / "config.backup.json"
    
    # Check if original file exists
    if not original_file.exists():
        print("ERROR: Original file config.json does not exist")
        return False
    
    # Check if backup file exists
    if not backup_file.exists():
        print("FAIL: Backup file config.backup.json does not exist")
        return False
    
    # Read both files
    try:
        with open(original_file, 'r') as f:
            original_content = f.read()
    except Exception as e:
        print(f"ERROR: Could not read original file: {e}")
        return False
    
    try:
        with open(backup_file, 'r') as f:
            backup_content = f.read()
    except Exception as e:
        print(f"ERROR: Could not read backup file: {e}")
        return False
    
    # Compare contents
    if original_content != backup_content:
        print("FAIL: Backup file content does not match original file")
        print(f"Original length: {len(original_content)} bytes")
        print(f"Backup length: {len(backup_content)} bytes")
        return False
    
    # Verify it's valid JSON (optional but good practice)
    try:
        json.loads(backup_content)
    except json.JSONDecodeError:
        print("WARNING: Backup file is not valid JSON, but content matches")
    
    print("SUCCESS: Backup file created successfully with matching content")
    return True

if __name__ == "__main__":
    result = evaluate()
    exit(0 if result else 1)