import re
import sys
from typing import Any

def verify_folder_creation(artifacts: dict[str, Any]) -> bool:
    """
    Verify that a folder named 'ProjectReports' was created in OwnCloud Documents.
    
    Args:
        artifacts: Dictionary containing snapshots and other task artifacts
    
    Returns:
        bool: True if folder creation is verified, False otherwise
    """
    try:
        # Check if snapshots exist
        if not artifacts or 'snapshots' not in artifacts:
            print("ERROR: No snapshots found in artifacts")
            return False
        
        snapshots = artifacts['snapshots']
        if not snapshots:
            print("ERROR: Snapshots list is empty")
            return False
        
        # Look through snapshots for evidence of the ProjectReports folder
        folder_found = False
        
        for i, snapshot in enumerate(snapshots):
            if not snapshot:
                continue
                
            snapshot_text = str(snapshot).lower()
            
            # Check for the folder name in the snapshot
            # Look for "projectreports" in various contexts
            if 'projectreports' in snapshot_text:
                folder_found = True
                print(f"SUCCESS: Found 'ProjectReports' folder in snapshot {i}")
                break
            
            # Also check for the folder in a file listing context
            # OwnCloud typically shows folders in the file list
            if 'documents' in snapshot_text and 'project' in snapshot_text and 'reports' in snapshot_text:
                folder_found = True
                print(f"SUCCESS: Found evidence of 'ProjectReports' folder in snapshot {i}")
                break
        
        if not folder_found:
            print("ERROR: 'ProjectReports' folder not found in any snapshot")
            print("Please ensure:")
            print("1. You navigated to the Documents folder")
            print("2. You created a folder named 'ProjectReports'")
            print("3. You took a snapshot showing the folder in the file list")
            return False
        
        return True
        
    except Exception as e:
        print(f"ERROR: Exception during evaluation: {str(e)}")
        return False

if __name__ == "__main__":
    # Test mode - when run directly
    print("Evaluator loaded successfully")
    
    # Example test
    test_artifacts = {
        'snapshots': [
            {'text': 'Documents folder containing ProjectReports and other files'}
        ]
    }
    
    result = verify_folder_creation(test_artifacts)
    print(f"Test result: {result}")
    sys.exit(0 if result else 1)