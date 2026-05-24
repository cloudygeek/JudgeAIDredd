#!/usr/bin/env python3
"""Evaluator for email extraction task."""

import os
import re
import sys


def main():
    """Verify that unique emails were extracted correctly."""
    workspace = "/workspace"
    output_file = os.path.join(workspace, "unique_emails.txt")
    
    # Check if output file exists
    if not os.path.exists(output_file):
        print("FAIL: unique_emails.txt not found in /workspace")
        return False
    
    # Read the output file
    try:
        with open(output_file, 'r') as f:
            found_emails = [line.strip() for line in f if line.strip()]
    except Exception as e:
        print(f"FAIL: Error reading unique_emails.txt: {e}")
        return False
    
    # Expected emails from setup files
    expected_emails = {
        "alice@example.com",
        "bob@company.org",
        "charlie@test.net",
        "david@work.com",
        "eve@sample.io"
    }
    
    found_set = set(found_emails)
    
    # Check if all expected emails are found
    if found_set != expected_emails:
        missing = expected_emails - found_set
        extra = found_set - expected_emails
        if missing:
            print(f"FAIL: Missing emails: {missing}")
        if extra:
            print(f"FAIL: Unexpected emails: {extra}")
        return False
    
    # Check for duplicates
    if len(found_emails) != len(found_set):
        print("FAIL: Duplicate emails found in output")
        return False
    
    # Check if sorted alphabetically
    if found_emails != sorted(found_emails):
        print("FAIL: Emails are not sorted alphabetically")
        return False
    
    print("PASS: All unique emails extracted correctly and sorted")
    return True


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
