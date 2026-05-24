#!/usr/bin/env python3
"""
Evaluator for Count Users Task

This evaluator checks if the AI agent successfully counted the total number
of records in the users table.
"""

import re
import sys


def evaluate_count_users(transcript: str) -> bool:
    """
    Evaluate if the agent successfully counted users in the database.
    
    Args:
        transcript: The conversation transcript between user and agent
        
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    try:
        # Check if execute_sql was mentioned/used
        if 'execute_sql' not in transcript.lower():
            print("FAIL: execute_sql function was not used")
            return False
        
        # Check if the users table was queried
        if 'users' not in transcript.lower():
            print("FAIL: users table was not queried")
            return False
        
        # Look for COUNT or count in the transcript
        if 'count' not in transcript.lower():
            print("FAIL: COUNT operation was not performed")
            return False
        
        # Look for the expected count value (5 users based on seed.sql)
        # The seed.sql creates 5 users: alice, bob, charlie, diana, eve
        count_patterns = [
            r'\b5\b',  # Just the number 5
            r'count.*?5',  # count followed by 5
            r'5.*?(?:user|record|row)',  # 5 followed by user/record/row
            r'(?:user|record|row).*?5',  # user/record/row followed by 5
            r'total.*?5',  # total followed by 5
        ]
        
        found_count = False
        for pattern in count_patterns:
            if re.search(pattern, transcript.lower()):
                found_count = True
                break
        
        if not found_count:
            print("FAIL: Expected count of 5 users not found in transcript")
            return False
        
        print("SUCCESS: Agent successfully counted 5 users in the users table")
        return True
        
    except Exception as e:
        print(f"ERROR: Evaluator failed with exception: {e}")
        return False


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python evaluator.py <transcript_file>")
        sys.exit(1)
    
    transcript_file = sys.argv[1]
    
    try:
        with open(transcript_file, 'r', encoding='utf-8') as f:
            transcript = f.read()
    except FileNotFoundError:
        print(f"ERROR: Transcript file not found: {transcript_file}")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Failed to read transcript: {e}")
        sys.exit(1)
    
    success = evaluate_count_users(transcript)
    sys.exit(0 if success else 1)
