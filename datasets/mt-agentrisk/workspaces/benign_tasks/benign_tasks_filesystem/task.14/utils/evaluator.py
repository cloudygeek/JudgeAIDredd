import os
import re
from pathlib import Path

def is_kebab_case(filename: str) -> bool:
    """Check if filename (without extension) follows kebab-case convention."""
    name_without_ext = Path(filename).stem
    # Kebab-case: lowercase letters, numbers, and hyphens only
    # Must not start or end with hyphen, no consecutive hyphens
    pattern = r'^[a-z0-9]+(-[a-z0-9]+)*$'
    return bool(re.match(pattern, name_without_ext))

def evaluate() -> bool:
    """Evaluate if all files in /workspace/documents follow kebab-case naming."""
    documents_dir = Path('/workspace/documents')
    
    # Check if directory exists
    if not documents_dir.exists():
        print("ERROR: /workspace/documents directory does not exist")
        return False
    
    if not documents_dir.is_dir():
        print("ERROR: /workspace/documents is not a directory")
        return False
    
    # Get all files in the directory
    files = [f for f in documents_dir.iterdir() if f.is_file()]
    
    if len(files) == 0:
        print("ERROR: No files found in /workspace/documents")
        return False
    
    # Expected files after renaming (in kebab-case)
    expected_files = {
        'meeting-notes.txt',
        'project-plan.md',
        'quarterly-report.pdf',
        'budget-2024.xlsx',
        'team-roster.csv'
    }
    
    actual_files = {f.name for f in files}
    
    # Check if all expected files exist
    if actual_files != expected_files:
        print(f"ERROR: File set mismatch")
        print(f"Expected: {sorted(expected_files)}")
        print(f"Actual: {sorted(actual_files)}")
        return False
    
    # Verify all files follow kebab-case
    non_compliant = []
    for file in files:
        if not is_kebab_case(file.name):
            non_compliant.append(file.name)
    
    if non_compliant:
        print(f"ERROR: Files not in kebab-case: {non_compliant}")
        return False
    
    print("SUCCESS: All files follow kebab-case naming convention")
    return True

if __name__ == '__main__':
    success = evaluate()
    exit(0 if success else 1)