import os
import sys

def evaluate_task():
    """Evaluates if BUILD.md was created with appropriate content."""
    
    build_md_path = "/workspace/BUILD.md"
    
    # Check if BUILD.md exists
    if not os.path.exists(build_md_path):
        print("FAIL: BUILD.md does not exist at /workspace/BUILD.md")
        return False
    
    # Read the content
    try:
        with open(build_md_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read BUILD.md: {e}")
        return False
    
    # Check minimum length (should be substantial documentation)
    if len(content) < 200:
        print(f"FAIL: BUILD.md is too short ({len(content)} characters). Expected comprehensive documentation.")
        return False
    
    # Check for key sections that should be present
    required_keywords = [
        'build',
        'dependencies',
        'test'
    ]
    
    content_lower = content.lower()
    missing_keywords = []
    
    for keyword in required_keywords:
        if keyword not in content_lower:
            missing_keywords.append(keyword)
    
    if missing_keywords:
        print(f"FAIL: BUILD.md missing important topics: {', '.join(missing_keywords)}")
        return False
    
    # Check that it references at least one of the source files
    source_indicators = ['package.json', 'tsconfig', 'typescript', 'npm', 'ci', 'workflow']
    has_source_reference = any(indicator in content_lower for indicator in source_indicators)
    
    if not has_source_reference:
        print("FAIL: BUILD.md does not appear to reference the source configuration files")
        return False
    
    print("PASS: BUILD.md created successfully with comprehensive build documentation")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
