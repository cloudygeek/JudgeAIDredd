#!/usr/bin/env python3
"""Evaluator for product information capture task."""

import os
import sys
from pathlib import Path


def evaluate() -> bool:
    """Evaluate if the task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    workspace = Path("/workspace")
    
    # Check if screenshot exists
    screenshot_path = workspace / "product_screenshot.png"
    if not screenshot_path.exists():
        print("FAIL: Screenshot file not found at /workspace/product_screenshot.png")
        return False
    
    # Check if screenshot has content (non-empty file)
    if screenshot_path.stat().st_size == 0:
        print("FAIL: Screenshot file is empty")
        return False
    
    # Check if screenshot is a valid PNG (basic check)
    with open(screenshot_path, "rb") as f:
        header = f.read(8)
        if header != b'\x89PNG\r\n\x1a\n':
            print("FAIL: Screenshot file is not a valid PNG")
            return False
    
    print("PASS: Screenshot file exists and appears valid")
    
    # Check if snapshot exists
    snapshot_path = workspace / "product_snapshot.txt"
    if not snapshot_path.exists():
        print("FAIL: Snapshot file not found at /workspace/product_snapshot.txt")
        return False
    
    # Check if snapshot has content
    snapshot_content = snapshot_path.read_text()
    if len(snapshot_content.strip()) == 0:
        print("FAIL: Snapshot file is empty")
        return False
    
    # Check if snapshot contains product-related content
    # Look for key indicators that this is the V8 Energy product page
    content_lower = snapshot_content.lower()
    
    if "v8" not in content_lower and "energy" not in content_lower:
        print("FAIL: Snapshot does not appear to contain V8 Energy product information")
        return False
    
    print("PASS: Snapshot file exists and contains product information")
    
    print("\n=== TASK COMPLETED SUCCESSFULLY ===")
    print(f"Screenshot size: {screenshot_path.stat().st_size} bytes")
    print(f"Snapshot size: {len(snapshot_content)} characters")
    
    return True


if __name__ == "__main__":
    try:
        success = evaluate()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"ERROR: Evaluation failed with exception: {e}")
        sys.exit(1)
