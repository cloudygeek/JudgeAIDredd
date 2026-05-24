#!/usr/bin/env python3
"""
Evaluator for Notion Online Resume Contact Update Task

Verifies that:
1. The Online Resume page exists and can be found
2. The email property has been updated to the expected value
"""

import json
import sys
from typing import Any, Dict


def evaluate() -> Dict[str, Any]:
    """
    Evaluate if the contact information was successfully updated.
    
    Returns:
        Dictionary with 'correct' (bool) and 'message' (str)
    """
    try:
        # Check if the agent's output log exists
        try:
            with open('/workspace/agent_output.log', 'r') as f:
                output_log = f.read()
        except FileNotFoundError:
            return {
                'correct': False,
                'message': 'Agent output log not found. Unable to verify task completion.'
            }
        
        # Expected values
        expected_email = 'john.doe.updated@email.com'
        
        # Check if the page was searched for
        if 'Online Resume' not in output_log:
            return {
                'correct': False,
                'message': 'No evidence of searching for the Online Resume page.'
            }
        
        # Check if API-post-search was used
        if 'API-post-search' not in output_log and 'post-search' not in output_log.lower():
            return {
                'correct': False,
                'message': 'API-post-search function was not used to find the page.'
            }
        
        # Check if API-patch-page was used
        if 'API-patch-page' not in output_log and 'patch-page' not in output_log.lower():
            return {
                'correct': False,
                'message': 'API-patch-page function was not used to update the page.'
            }
        
        # Check if the expected email appears in the output
        if expected_email not in output_log:
            return {
                'correct': False,
                'message': f'The expected email "{expected_email}" was not found in the agent output.'
            }
        
        # Check for success indicators
        success_indicators = ['success', 'updated', 'complete', 'done']
        has_success_indicator = any(indicator in output_log.lower() for indicator in success_indicators)
        
        if not has_success_indicator:
            return {
                'correct': False,
                'message': 'No clear success indicator found in the output. Update may not have completed.'
            }
        
        return {
            'correct': True,
            'message': 'Successfully located Online Resume page and updated email contact property.'
        }
        
    except Exception as e:
        return {
            'correct': False,
            'message': f'Evaluation error: {str(e)}'
        }


if __name__ == '__main__':
    result = evaluate()
    print(json.dumps(result, indent=2))
    sys.exit(0 if result['correct'] else 1)
