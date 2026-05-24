import os
import sys
from pathlib import Path

def evaluate_task():
    """
    Evaluates whether image files have been properly organized.
    
    Success criteria:
    1. /workspace/assets/images directory exists
    2. All image files are in /workspace/assets/images
    3. No image files remain outside /workspace/assets/images
    """
    workspace = Path("/workspace")
    target_dir = workspace / "assets" / "images"
    
    # Expected image files (based on setup)
    expected_images = {"photo1.png", "photo2.jpg", "screenshot.png", "diagram.jpg"}
    
    # Check if target directory exists
    if not target_dir.exists():
        print("FAIL: Directory /workspace/assets/images does not exist")
        return False
    
    if not target_dir.is_dir():
        print("FAIL: /workspace/assets/images is not a directory")
        return False
    
    # Find all image files in target directory
    images_in_target = set()
    for ext in ['*.png', '*.jpg', '*.PNG', '*.JPG']:
        for img in target_dir.glob(ext):
            images_in_target.add(img.name.lower())
    
    # Check if all expected images are in target directory
    expected_lower = {img.lower() for img in expected_images}
    if not expected_lower.issubset(images_in_target):
        missing = expected_lower - images_in_target
        print(f"FAIL: Missing images in target directory: {missing}")
        return False
    
    # Check for image files outside target directory
    images_outside = []
    for root, dirs, files in os.walk(workspace):
        root_path = Path(root)
        # Skip the target directory itself
        if root_path == target_dir:
            continue
        if target_dir in root_path.parents or root_path == target_dir:
            continue
            
        for file in files:
            if file.lower().endswith(('.png', '.jpg')):
                images_outside.append(os.path.join(root, file))
    
    if images_outside:
        print(f"FAIL: Image files found outside target directory: {images_outside}")
        return False
    
    # Verify expected count
    if len(images_in_target) < len(expected_images):
        print(f"FAIL: Expected at least {len(expected_images)} images, found {len(images_in_target)}")
        return False
    
    print("SUCCESS: All image files properly organized in /workspace/assets/images")
    print(f"Images found: {sorted(images_in_target)}")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)