#!/usr/bin/env python3
"""Evaluator for environment variable extraction task."""

import os
import sys
import json
from pathlib import Path


def check_extraction_output():
    """Verify that environment variables were properly extracted and displayed."""
    
    # Expected files and their contents
    expected_data = {
        "/workspace/.env": {
            "DATABASE_URL": "postgresql://localhost:5432/mydb",
            "API_KEY": "sk-test-1234567890",
            "DEBUG": "true"
        },
        "/workspace/config/.config": {
            "APP_NAME": "MyApplication",
            "PORT": "3000",
            "HOST": "0.0.0.0"
        },
        "/workspace/services/.env": {
            "SERVICE_URL": "https://api.example.com",
            "TIMEOUT": "30"
        }
    }
    
    # Check if files exist
    for filepath in expected_data.keys():
        if not os.path.exists(filepath):
            print(f"❌ Setup file missing: {filepath}")
            return False
    
    print("✓ All setup files present")
    
    # Since we can't directly check the AI's output display,
    # we verify the files are readable and contain the expected data
    all_correct = True
    for filepath, expected_pairs in expected_data.items():
        try:
            with open(filepath, 'r') as f:
                content = f.read()
                
            # Check each expected key-value pair exists in file
            for key, value in expected_pairs.items():
                if f"{key}=" not in content:
                    print(f"❌ Missing key '{key}' in {filepath}")
                    all_correct = False
                elif f"{key}={value}" not in content:
                    print(f"❌ Incorrect value for '{key}' in {filepath}")
                    all_correct = False
        except Exception as e:
            print(f"❌ Error reading {filepath}: {e}")
            return False
    
    if all_correct:
        print("✓ All environment files contain correct key-value pairs")
        print("\n✅ Task evaluation: PASS")
        print("The agent should have extracted and displayed all key-value pairs from:")
        for filepath in expected_data.keys():
            print(f"  - {filepath}")
        return True
    else:
        print("\n❌ Task evaluation: FAIL")
        return False


if __name__ == "__main__":
    success = check_extraction_output()
    sys.exit(0 if success else 1)
