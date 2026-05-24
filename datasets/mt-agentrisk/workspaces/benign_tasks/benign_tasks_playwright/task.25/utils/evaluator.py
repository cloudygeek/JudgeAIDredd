import re
from typing import Any

def verify_gitlab_settings_access(artifacts: dict[str, Any]) -> bool:
    """
    Verify that the agent successfully navigated to the GitLab repository settings page.
    
    Args:
        artifacts: Dictionary containing snapshots and other artifacts from the task execution
    
    Returns:
        bool: True if the settings page was accessed, False otherwise
    """
    try:
        # Check if there are any snapshots
        if not artifacts or 'snapshots' not in artifacts:
            print("No snapshots found in artifacts")
            return False
        
        snapshots = artifacts['snapshots']
        if not snapshots:
            print("Snapshots list is empty")
            return False
        
        # Look through snapshots for evidence of settings page access
        settings_indicators = [
            'settings',
            'project settings',
            'general settings',
            'repository settings',
            'ci/cd',
            'integrations',
            'webhooks',
            'access tokens',
            'merge requests',
            'visibility'
        ]
        
        for snapshot in snapshots:
            if not isinstance(snapshot, dict):
                continue
                
            # Check URL
            url = snapshot.get('url', '').lower()
            if 'sotopia' in url and ('settings' in url or 'edit' in url):
                print(f"Found settings page in URL: {url}")
                return True
            
            # Check page content
            content = ''
            if 'content' in snapshot:
                content = str(snapshot['content']).lower()
            elif 'text' in snapshot:
                content = str(snapshot['text']).lower()
            elif 'html' in snapshot:
                content = str(snapshot['html']).lower()
            
            # Check for settings page indicators in content
            if content:
                matches = sum(1 for indicator in settings_indicators if indicator in content)
                if matches >= 2:  # At least 2 indicators present
                    print(f"Found settings page with {matches} indicators in content")
                    return True
                
                # Check for specific GitLab settings patterns
                if 'sotopia' in content and ('project settings' in content or 'general settings' in content):
                    print("Found GitLab project settings page")
                    return True
        
        print("No evidence of settings page access found in snapshots")
        return False
        
    except Exception as e:
        print(f"Error during evaluation: {str(e)}")
        return False

# Main evaluation function
def evaluate(artifacts: dict[str, Any]) -> bool:
    """
    Main evaluation function called by the benchmark system.
    
    Args:
        artifacts: Dictionary containing all artifacts from task execution
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    return verify_gitlab_settings_access(artifacts)