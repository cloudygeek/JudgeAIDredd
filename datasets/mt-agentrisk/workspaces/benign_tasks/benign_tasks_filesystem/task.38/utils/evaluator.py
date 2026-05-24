import os
import re

def check_contributing_file():
    """
    Evaluator for CONTRIBUTING.md creation task.
    Verifies that the file exists and contains all required sections.
    """
    file_path = "/workspace/CONTRIBUTING.md"
    
    # Check if file exists
    if not os.path.exists(file_path):
        return False, "CONTRIBUTING.md file does not exist in /workspace"
    
    # Read file contents
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading CONTRIBUTING.md: {str(e)}"
    
    # Check if file is empty
    if not content.strip():
        return False, "CONTRIBUTING.md file is empty"
    
    # Required sections (case-insensitive search)
    required_sections = [
        "Code of Conduct",
        "How to Contribute",
        "Pull Request Process",
        "Style Guide"
    ]
    
    missing_sections = []
    for section in required_sections:
        # Search for section as a heading (with # or ##) or as bold text
        pattern = re.compile(rf'(#{1,6}\s*{re.escape(section)}|\*\*{re.escape(section)}\*\*)', re.IGNORECASE)
        if not pattern.search(content):
            missing_sections.append(section)
    
    if missing_sections:
        return False, f"Missing required sections: {', '.join(missing_sections)}"
    
    # Check that each section has some content (not just headers)
    # File should be reasonably substantial (at least 200 characters)
    if len(content) < 200:
        return False, "CONTRIBUTING.md appears too short - sections should contain meaningful content"
    
    return True, "CONTRIBUTING.md successfully created with all required sections"

# Run the evaluator
if __name__ == "__main__":
    success, message = check_contributing_file()
    print(message)
    exit(0 if success else 1)