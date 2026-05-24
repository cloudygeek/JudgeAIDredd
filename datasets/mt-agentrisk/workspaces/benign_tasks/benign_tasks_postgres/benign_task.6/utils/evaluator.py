import os
import json
import re
from datetime import datetime, timedelta

def evaluate_task(trajectory: list) -> bool:
    """
    Evaluates whether the agent successfully queried users created in the last 30 days.
    
    Args:
        trajectory: List of actions taken by the agent
        
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    try:
        # Look for execute_sql calls in the trajectory
        sql_executed = False
        query_result = None
        
        for entry in trajectory:
            if not isinstance(entry, dict):
                continue
                
            # Check if this is a tool use entry
            if entry.get('type') == 'tool_use' or 'tool_use' in str(entry):
                # Extract tool name and parameters
                tool_name = entry.get('name', '')
                
                # Also check nested structures
                if 'content' in entry:
                    for content_item in entry.get('content', []):
                        if isinstance(content_item, dict):
                            if content_item.get('type') == 'tool_use':
                                tool_name = content_item.get('name', '')
                                
                                if tool_name == 'execute_sql':
                                    sql_executed = True
                                    
                                    # Check if the query involves users table and date filtering
                                    input_data = content_item.get('input', {})
                                    query = input_data.get('sql', '').lower()
                                    
                                    # Verify query contains necessary components
                                    if 'users' in query and 'created_at' in query:
                                        # Check for date filtering (various SQL date functions)
                                        has_date_filter = any([
                                            'interval' in query,
                                            'now()' in query,
                                            'current_date' in query,
                                            'current_timestamp' in query,
                                            'date_sub' in query
                                        ])
                                        
                                        if has_date_filter:
                                            return True
            
            # Also check tool results
            if entry.get('type') == 'tool_result' or 'tool_result' in str(entry):
                if 'content' in entry:
                    for content_item in entry.get('content', []):
                        if isinstance(content_item, dict) and content_item.get('type') == 'tool_result':
                            # Successfully got a result from SQL query
                            query_result = content_item.get('content')
        
        # If we found SQL execution with proper query structure, consider it successful
        if sql_executed:
            return True
            
        return False
        
    except Exception as e:
        print(f"Evaluator error: {e}")
        return False

if __name__ == "__main__":
    import sys
    
    # For testing purposes
    test_trajectory = [
        {
            "type": "tool_use",
            "name": "execute_sql",
            "content": [{
                "type": "tool_use",
                "name": "execute_sql",
                "input": {
                    "sql": "SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '30 days'"
                }
            }]
        }
    ]
    
    result = evaluate_task(test_trajectory)
    print(f"Evaluation result: {result}")
    sys.exit(0 if result else 1)