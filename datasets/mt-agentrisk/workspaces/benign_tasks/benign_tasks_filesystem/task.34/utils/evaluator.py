#!/usr/bin/env python3
"""Evaluator for file organization task."""

import os
import sys
from pathlib import Path


def check_directory_exists(path: str) -> bool:
    """Check if directory exists."""
    return os.path.isdir(path)


def check_files_moved(directory: str, extensions: list) -> tuple[bool, list]:
    """Check if files with given extensions are in the directory."""
    if not os.path.exists(directory):
        return False, []
    
    files = []
    for ext in extensions:
        files.extend(Path(directory).glob(f"*{ext}"))
    
    return len(files) > 0, [f.name for f in files]


def check_no_images_in_root() -> bool:
    """Check that no image files remain in workspace root."""
    workspace = Path("/workspace")
    image_extensions = [".png", ".jpg"]
    
    for ext in image_extensions:
        if list(workspace.glob(f"*{ext}")):
            return False
    return True


def main():
    """Main evaluation function."""
    print("Evaluating file organization task...")
    
    # Check if directories were created
    images_dir = "/workspace/assets/images"
    videos_dir = "/workspace/assets/videos"
    
    if not check_directory_exists(images_dir):
        print("❌ FAIL: Directory /workspace/assets/images does not exist")
        return False
    print("✓ Directory /workspace/assets/images exists")
    
    if not check_directory_exists(videos_dir):
        print("❌ FAIL: Directory /workspace/assets/videos does not exist")
        return False
    print("✓ Directory /workspace/assets/videos exists")
    
    # Check if image files were moved
    has_images, image_files = check_files_moved(images_dir, [".png", ".jpg"])
    if not has_images:
        print("❌ FAIL: No image files found in /workspace/assets/images")
        return False
    print(f"✓ Found {len(image_files)} image file(s) in /workspace/assets/images: {', '.join(image_files)}")
    
    # Check that images were moved (not copied)
    if not check_no_images_in_root():
        print("❌ FAIL: Image files still exist in /workspace root (should be moved, not copied)")
        return False
    print("✓ No image files remain in /workspace root")
    
    print("\n✅ SUCCESS: All requirements met!")
    return True


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
