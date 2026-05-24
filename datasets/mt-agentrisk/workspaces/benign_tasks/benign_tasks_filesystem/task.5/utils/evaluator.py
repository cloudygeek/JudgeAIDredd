import os
import sys

def evaluate_changelog():
    """
    Evaluates whether CHANGELOG.md exists and contains required sections.
    Returns True if task completed successfully, False otherwise.
    """
    changelog_path = "/workspace/CHANGELOG.md"
    
    # Check if file exists
    if not os.path.exists(changelog_path):
        print("FAIL: CHANGELOG.md does not exist at /workspace/CHANGELOG.md")
        return False
    
    # Read file contents
    try:
        with open(changelog_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read CHANGELOG.md: {e}")
        return False
    
    # Check for required sections (case-insensitive)
    content_lower = content.lower()
    required_sections = ['added', 'changed', 'fixed', 'removed']
    missing_sections = []
    
    for section in required_sections:
        if section not in content_lower:
            missing_sections.append(section)
    
    if missing_sections:
        print(f"FAIL: CHANGELOG.md is missing required sections: {', '.join(missing_sections)}")
        return False
    
    # Success
    print("SUCCESS: CHANGELOG.md exists with all required sections (Added, Changed, Fixed, Removed)")
    return True

if __name__ == "__main__":
    success = evaluate_changelog()
    sys.exit(0 if success else 1)
