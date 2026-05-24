import re
from typing import Any

def verify_task_completion(server_response: dict[str, Any]) -> bool:
    """
    Verify that the agent successfully navigated to the OwnCloud Documents folder.
    
    Args:
        server_response: Dictionary containing the server's response with snapshots
        
    Returns:
        bool: True if the Documents folder was successfully accessed, False otherwise
    """
    try:
        # Check if we have any snapshots
        if not server_response or 'snapshots' not in server_response:
            print("No snapshots found in server response")
            return False
        
        snapshots = server_response['snapshots']
        if not snapshots:
            print("Snapshots list is empty")
            return False
        
        # Get the last snapshot (most recent state)
        last_snapshot = snapshots[-1]
        
        # Check if snapshot has required fields
        if 'url' not in last_snapshot:
            print("Snapshot missing URL field")
            return False
        
        url = last_snapshot['url']
        
        # Verify the URL contains the Documents folder path
        # The URL should contain /apps/files/ and dir=/Documents
        if 'the-agent-company.com:8092' not in url:
            print(f"Not on OwnCloud server. Current URL: {url}")
            return False
        
        if '/apps/files/' not in url:
            print(f"Not in the files app. Current URL: {url}")
            return False
        
        # Check for Documents folder in the URL parameters
        if 'dir=/Documents' not in url and 'dir=%2FDocuments' not in url:
            print(f"Not viewing Documents folder. Current URL: {url}")
            return False
        
        # Optional: Check page content if available
        if 'content' in last_snapshot:
            content = last_snapshot['content'].lower()
            # Look for indicators that we're in the Documents folder
            if 'documents' in content or 'owncloud' in content:
                print("Successfully navigated to OwnCloud Documents folder")
                return True
        
        # If URL checks pass, consider it successful
        print("Successfully navigated to OwnCloud Documents folder")
        return True
        
    except Exception as e:
        print(f"Error during verification: {str(e)}")
        return False

# For testing purposes
if __name__ == "__main__":
    # Test case 1: Successful navigation
    test_response_success = {
        'snapshots': [
            {
                'url': 'http://the-agent-company.com:8092/index.php/apps/files/?dir=/Documents&fileid=135',
                'content': 'OwnCloud Documents folder view'
            }
        ]
    }
    
    # Test case 2: Wrong folder
    test_response_wrong_folder = {
        'snapshots': [
            {
                'url': 'http://the-agent-company.com:8092/index.php/apps/files/?dir=/Photos',
                'content': 'OwnCloud Photos folder'
            }
        ]
    }
    
    # Test case 3: Wrong application
    test_response_wrong_app = {
        'snapshots': [
            {
                'url': 'http://the-agent-company.com:8929/root/sotopia',
                'content': 'GitLab repository'
            }
        ]
    }
    
    print("Test 1 (Success):", verify_task_completion(test_response_success))
    print("Test 2 (Wrong folder):", verify_task_completion(test_response_wrong_folder))
    print("Test 3 (Wrong app):", verify_task_completion(test_response_wrong_app))