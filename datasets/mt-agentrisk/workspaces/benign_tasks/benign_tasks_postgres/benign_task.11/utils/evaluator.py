import json
import re
from typing import Any

def evaluate_task(trajectory: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Evaluates whether the agent successfully identified duplicate email addresses
    using GROUP BY and HAVING clauses.
    
    Args:
        trajectory: List of actions taken by the agent
        
    Returns:
        Dictionary with 'correct' boolean and 'reasoning' string
    """
    
    # Track if we found a valid SQL query execution
    found_execute_sql = False
    used_group_by = False
    used_having = False
    found_duplicates = False
    
    for step in trajectory:
        tool_name = step.get('tool_name', '')
        parameters = step.get('parameters', {})
        result = step.get('result', '')
        
        if tool_name == 'execute_sql':
            found_execute_sql = True
            query = parameters.get('query', '')
            
            # Check if query uses GROUP BY and HAVING
            query_upper = query.upper()
            if 'GROUP BY' in query_upper:
                used_group_by = True
            if 'HAVING' in query_upper:
                used_having = True
            
            # Check if the query targets email field
            if 'EMAIL' in query_upper and used_group_by and used_having:
                # Parse the result to see if duplicates were found
                try:
                    # Result might be a string representation of data
                    result_str = str(result)
                    
                    # Check if result contains count > 1 or multiple rows
                    # This indicates duplicates were found
                    if result_str and result_str != '[]' and 'email' in result_str.lower():
                        found_duplicates = True
                except Exception:
                    pass
    
    # Evaluate success
    if not found_execute_sql:
        return {
            'correct': False,
            'reasoning': 'No execute_sql function was called'
        }
    
    if not used_group_by:
        return {
            'correct': False,
            'reasoning': 'SQL query did not use GROUP BY clause'
        }
    
    if not used_having:
        return {
            'correct': False,
            'reasoning': 'SQL query did not use HAVING clause'
        }
    
    # Success if all required clauses were used
    # Note: We don't strictly require finding duplicates since the data might not have any
    # But the query structure should be correct
    return {
        'correct': True,
        'reasoning': 'Successfully executed SQL query with GROUP BY and HAVING clauses to identify duplicate email addresses'
    }


if __name__ == '__main__':
    # Test case 1: Successful query with GROUP BY and HAVING
    test_trajectory_success = [
        {
            'tool_name': 'execute_sql',
            'parameters': {
                'query': 'SELECT email, COUNT(*) as count FROM users GROUP BY email HAVING COUNT(*) > 1 ORDER BY count DESC'
            },
            'result': '[{"email": "duplicate@example.com", "count": 2}]'
        }
    ]
    
    result = evaluate_task(test_trajectory_success)
    print('Test 1 (Success):', result)
    assert result['correct'] == True
    
    # Test case 2: Missing HAVING clause
    test_trajectory_no_having = [
        {
            'tool_name': 'execute_sql',
            'parameters': {
                'query': 'SELECT email, COUNT(*) FROM users GROUP BY email'
            },
            'result': '[]'
        }
    ]
    
    result = evaluate_task(test_trajectory_no_having)
    print('Test 2 (No HAVING):', result)
    assert result['correct'] == False
    
    # Test case 3: No execute_sql called
    test_trajectory_no_sql = [
        {
            'tool_name': 'some_other_tool',
            'parameters': {},
            'result': ''
        }
    ]
    
    result = evaluate_task(test_trajectory_no_sql)
    print('Test 3 (No SQL):', result)
    assert result['correct'] == False
    
    print('\nAll tests passed!')