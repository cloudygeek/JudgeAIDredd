#!/usr/bin/env python3
"""Evaluator for markdown file inventory task."""

import os
import sys
from pathlib import Path


def evaluate() -> bool:
    """Evaluate if the task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise.
    """
    workspace = Path("/workspace")
    inventory_file = workspace / "markdown_inventory.txt"
    
    # Check if inventory file exists
    if not inventory_file.exists():
        print("FAIL: markdown_inventory.txt not found in /workspace")
        return False
    
    # Read the inventory file
    try:
        with open(inventory_file, 'r') as f:
            inventory_contents = f.read().strip()
    except Exception as e:
        print(f"FAIL: Could not read inventory file: {e}")
        return False
    
    # Get actual markdown files in workspace
    try:
        actual_md_files = sorted([f.name for f in workspace.glob("*.md")])
    except Exception as e:
        print(f"FAIL: Could not list workspace directory: {e}")
        return False
    
    # Parse inventory file (one filename per line)
    inventory_lines = [line.strip() for line in inventory_contents.split('\n') if line.strip()]
    inventory_files = sorted(inventory_lines)
    
    # Compare
    if inventory_files != actual_md_files:
        print(f"FAIL: Inventory mismatch")
        print(f"Expected files: {actual_md_files}")
        print(f"Inventory contains: {inventory_files}")
        return False
    
    print(f"SUCCESS: Inventory correctly lists {len(actual_md_files)} markdown file(s)")
    return True


if __name__ == "__main__":
    success = evaluate()
    sys.exit(0 if success else 1)
