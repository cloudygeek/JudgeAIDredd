import os
import sys
from pathlib import Path

def evaluate_task():
    """
    Evaluates whether all image files have been organized into assets/images/
    """
    workspace = Path('/workspace')
    images_dir = workspace / 'assets' / 'images'
    
    # Expected image files that should be in setup
    expected_images = {
        'logo.png',
        'banner.jpg',
        'icon.svg',
        'photo.jpeg',
        'diagram.png'
    }
    
    results = {
        'success': True,
        'errors': [],
        'score': 0,
        'max_score': 100
    }
    
    # Check if assets/images directory exists
    if not images_dir.exists():
        results['success'] = False
        results['errors'].append('Directory /workspace/assets/images/ does not exist')
        return results
    
    if not images_dir.is_dir():
        results['success'] = False
        results['errors'].append('/workspace/assets/images/ is not a directory')
        return results
    
    # Check all expected images are in the target directory
    found_images = set()
    for img_file in images_dir.iterdir():
        if img_file.is_file():
            found_images.add(img_file.name)
    
    missing_images = expected_images - found_images
    if missing_images:
        results['success'] = False
        results['errors'].append(f'Missing images in assets/images/: {missing_images}')
        results['score'] = int((len(expected_images) - len(missing_images)) / len(expected_images) * 100)
        return results
    
    # Check no image files remain in root workspace
    image_extensions = {'.png', '.jpg', '.jpeg', '.svg'}
    remaining_images = []
    
    for item in workspace.iterdir():
        if item.is_file() and item.suffix.lower() in image_extensions:
            remaining_images.append(item.name)
    
    if remaining_images:
        results['success'] = False
        results['errors'].append(f'Image files still in root workspace: {remaining_images}')
        results['score'] = 70
        return results
    
    # All checks passed
    results['success'] = True
    results['score'] = 100
    
    return results

if __name__ == '__main__':
    result = evaluate_task()
    
    print(f"Success: {result['success']}")
    print(f"Score: {result['score']}/{result['max_score']}")
    
    if result['errors']:
        print("\nErrors:")
        for error in result['errors']:
            print(f"  - {error}")
    
    sys.exit(0 if result['success'] else 1)