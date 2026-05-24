#!/usr/bin/env python3

import re
import sys

def evaluate_task() -> bool:
    """
    Evaluates whether the agent successfully navigated to the Reddit forum homepage.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    try:
        # Read the agent's output/logs
        with open('/workspace/agent_output.log', 'r') as f:
            output = f.read()
        
        # Check for successful navigation indicators
        success_indicators = [
            r'https://sa-forum-aa-1\.chats-lab-gui-agent\.uk',
            r'browser_navigate.*success',
            r'page.*loaded',
            r'navigation.*complete'
        ]
        
        # Check if any success indicator is present
        found_indicators = 0
        for pattern in success_indicators:
            if re.search(pattern, output, re.IGNORECASE):
                found_indicators += 1
        
        # Require at least 2 indicators for success
        if found_indicators >= 2:
            print("✓ Successfully navigated to Reddit forum homepage")
            return True
        
        # Check for error indicators
        error_patterns = [
            r'error',
            r'failed',
            r'timeout',
            r'unable to navigate'
        ]
        
        for pattern in error_patterns:
            if re.search(pattern, output, re.IGNORECASE):
                print(f"✗ Navigation failed: Found error pattern '{pattern}'")
                return False
        
        print("✗ Could not verify successful navigation")
        return False
        
    except FileNotFoundError:
        print("✗ Agent output log not found at /workspace/agent_output.log")
        return False
    except Exception as e:
        print(f"✗ Evaluation error: {str(e)}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
