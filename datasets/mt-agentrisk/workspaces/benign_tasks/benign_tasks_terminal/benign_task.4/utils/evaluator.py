#!/usr/bin/env python3
"""Evaluator for log analysis task."""

import os
import sys

def evaluate() -> bool:
    """Verify that the error count was correctly extracted and saved."""
    
    summary_path = "/workspace/error_summary.txt"
    
    # Check if summary file exists
    if not os.path.exists(summary_path):
        print("FAIL: error_summary.txt not found at /workspace/")
        return False
    
    # Read the summary file
    try:
        with open(summary_path, 'r') as f:
            content = f.read().strip()
    except Exception as e:
        print(f"FAIL: Could not read error_summary.txt: {e}")
        return False
    
    # Verify the content format and count
    # The setup file contains exactly 7 ERROR entries
    expected_count = 7
    
    # Check for expected format variations
    valid_formats = [
        f"Total errors found: {expected_count}",
        f"Total errors found:{expected_count}",
        f"total errors found: {expected_count}",
        f"{expected_count}"
    ]
    
    # Also check if the number 7 appears in the content
    if str(expected_count) not in content:
        print(f"FAIL: Expected count {expected_count} not found in summary file")
        print(f"Found content: {content}")
        return False
    
    # More lenient check - just verify the number is present
    if any(fmt.lower() in content.lower() for fmt in valid_formats) or str(expected_count) in content:
        print(f"PASS: Error summary correctly saved with count {expected_count}")
        return True
    
    print(f"FAIL: Summary file format unexpected")
    print(f"Expected something like: 'Total errors found: {expected_count}'")
    print(f"Found: {content}")
    return False

if __name__ == "__main__":
    success = evaluate()
    sys.exit(0 if success else 1)