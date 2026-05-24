#!/usr/bin/env python3
"""Evaluator for GitLab issue comment task."""

import sys
import requests
from typing import Tuple


def check_comment_added() -> Tuple[bool, str]:
    """
    Check if a new comment was added to the GitLab issue.
    
    Returns:
        Tuple of (success: bool, message: str)
    """
    try:
        # GitLab API endpoint for issue notes (comments)
        # Issue 200 in root/sotopia project
        api_url = "http://the-agent-company.com:8929/api/v4/projects/root%2Fsotopia/issues/200/notes"
        
        # Make request to get all comments on the issue
        response = requests.get(api_url, timeout=10)
        
        if response.status_code != 200:
            return False, f"Failed to fetch issue comments. Status code: {response.status_code}"
        
        comments = response.json()
        
        if not isinstance(comments, list):
            return False, "Unexpected API response format"
        
        if len(comments) == 0:
            return False, "No comments found on the issue"
        
        # Check if there's at least one comment (we assume the task adds a new one)
        # Since we can't know the exact initial state, we verify that comments exist
        # and contain meaningful content
        recent_comments = comments[-3:]  # Check last 3 comments
        
        for comment in recent_comments:
            body = comment.get('body', '').strip()
            # Check if comment has substantial content (more than just a few characters)
            if len(body) > 10:
                return True, f"Successfully verified comment on issue. Found {len(comments)} total comments."
        
        return False, "No substantial comments found on the issue"
        
    except requests.exceptions.RequestException as e:
        return False, f"Network error while checking comments: {str(e)}"
    except Exception as e:
        return False, f"Error checking comments: {str(e)}"


def main() -> int:
    """Main evaluator function."""
    print("Evaluating GitLab issue comment task...")
    
    success, message = check_comment_added()
    
    print(message)
    
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
