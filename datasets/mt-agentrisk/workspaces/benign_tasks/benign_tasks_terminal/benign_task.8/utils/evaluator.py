#!/usr/bin/env python3
import os
import sys
from pathlib import Path
from collections import defaultdict

def evaluate_task():
    """
    Evaluates whether files in /workspace have been organized into
    subdirectories based on their file extensions.
    """
    workspace = Path("/workspace")
    
    if not workspace.exists():
        print("FAIL: /workspace directory does not exist")
        return False
    
    # Check for files remaining in root
    root_files = [f for f in workspace.iterdir() if f.is_file()]
    if root_files:
        print(f"FAIL: Found {len(root_files)} file(s) still in /workspace root:")
        for f in root_files:
            print(f"  - {f.name}")
        return False
    
    # Verify subdirectories exist and contain appropriate files
    subdirs = [d for d in workspace.iterdir() if d.is_dir()]
    
    if not subdirs:
        print("FAIL: No subdirectories found in /workspace")
        return False
    
    print(f"Found {len(subdirs)} subdirectories")
    
    # Verify each subdirectory contains files with matching extensions
    issues = []
    total_files = 0
    
    for subdir in subdirs:
        files = [f for f in subdir.iterdir() if f.is_file()]
        total_files += len(files)
        
        if not files:
            issues.append(f"WARNING: Empty subdirectory {subdir.name}")
            continue
        
        # Determine expected extension from directory name
        dir_name = subdir.name.lower()
        
        # Map directory names to expected extensions
        extension_map = {
            'text': '.txt',
            'python': '.py',
            'json': '.json',
            'markdown': '.md',
            'no_extension': ''
        }
        
        expected_ext = extension_map.get(dir_name)
        
        # For custom extension directories, extract extension from name
        if expected_ext is None:
            expected_ext = f'.{dir_name}' if dir_name else ''
        
        # Check files in this directory
        for file in files:
            file_ext = file.suffix.lower()
            
            # Special case for no_extension directory
            if dir_name == 'no_extension':
                if file_ext:
                    issues.append(f"File {file.name} in no_extension/ has extension {file_ext}")
            else:
                if file_ext != expected_ext:
                    issues.append(f"File {file.name} with extension {file_ext} found in {dir_name}/ directory")
    
    if total_files == 0:
        print("FAIL: No files found in any subdirectory")
        return False
    
    if issues:
        print("FAIL: Found organization issues:")
        for issue in issues:
            print(f"  - {issue}")
        return False
    
    print(f"SUCCESS: All {total_files} files properly organized into {len(subdirs)} subdirectories")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
