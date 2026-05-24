import os
import sys

def evaluate_task():
    """Evaluates whether the summary task was completed successfully."""
    
    readme_path = "/workspace/README.md"
    summary_path = "/workspace/SUMMARY.md"
    
    # Check if README exists (should be from setup)
    if not os.path.exists(readme_path):
        print("FAIL: README.md not found at /workspace/README.md")
        return False
    
    # Check if SUMMARY.md was created
    if not os.path.exists(summary_path):
        print("FAIL: SUMMARY.md was not created at /workspace/SUMMARY.md")
        return False
    
    # Read both files
    try:
        with open(readme_path, 'r', encoding='utf-8') as f:
            readme_content = f.read()
        
        with open(summary_path, 'r', encoding='utf-8') as f:
            summary_content = f.read()
    except Exception as e:
        print(f"FAIL: Error reading files: {e}")
        return False
    
    # Check that summary is not empty
    if len(summary_content.strip()) == 0:
        print("FAIL: SUMMARY.md is empty")
        return False
    
    # Check that summary is shorter than README
    if len(summary_content) >= len(readme_content):
        print("FAIL: SUMMARY.md should be shorter than README.md")
        return False
    
    # Check that summary is at least 10% of README length (not too short)
    if len(summary_content) < len(readme_content) * 0.1:
        print("FAIL: SUMMARY.md appears too short to be a meaningful summary")
        return False
    
    # Check for some common summary elements (at least one should be present)
    summary_lower = summary_content.lower()
    has_structure = any([
        '##' in summary_content or '#' in summary_content,  # Headers
        '-' in summary_content or '*' in summary_content,    # Bullet points
        '\n\n' in summary_content                             # Paragraphs
    ])
    
    if not has_structure:
        print("WARN: SUMMARY.md may lack proper structure, but accepting...")
    
    print("PASS: SUMMARY.md successfully created with appropriate content")
    print(f"  - README length: {len(readme_content)} characters")
    print(f"  - SUMMARY length: {len(summary_content)} characters")
    print(f"  - Compression ratio: {len(summary_content)/len(readme_content)*100:.1f}%")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
