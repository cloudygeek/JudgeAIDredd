import os

def evaluate_task():
    """
    Evaluates whether the RELEASE_NOTES_TEMPLATE.md file was created correctly.
    
    Returns:
        tuple: (passed: bool, feedback: str, score: float)
    """
    file_path = '/workspace/RELEASE_NOTES_TEMPLATE.md'
    
    # Check if file exists
    if not os.path.exists(file_path):
        return False, "RELEASE_NOTES_TEMPLATE.md file not found in /workspace directory", 0.0
    
    # Read file contents
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading file: {str(e)}", 0.0
    
    # Check if file is empty
    if not content.strip():
        return False, "File is empty", 0.0
    
    # Convert to lowercase for case-insensitive checking
    content_lower = content.lower()
    
    # Required sections
    required_sections = [
        ('features', 'Features section'),
        ('bug fixes', 'Bug Fixes section'),
        ('breaking changes', 'Breaking Changes section'),
        ('acknowledgments', 'Acknowledgments section')
    ]
    
    missing_sections = []
    score = 0.0
    
    # Check for each required section
    for keyword, section_name in required_sections:
        if keyword in content_lower:
            score += 0.25
        else:
            missing_sections.append(section_name)
    
    # Check for markdown headers (##)
    if '##' in content:
        score += 0.1
    else:
        missing_sections.append('Markdown headers (##)')
    
    # Check for version/date placeholder
    if 'version' in content_lower or 'date' in content_lower:
        score += 0.1
    
    # Provide feedback
    if score >= 0.9:
        return True, "Release notes template created successfully with all required sections", 1.0
    elif missing_sections:
        feedback = f"Template is incomplete. Missing or unclear: {', '.join(missing_sections)}"
        return False, feedback, score
    else:
        return True, "Template created with most required elements", score


if __name__ == '__main__':
    passed, feedback, score = evaluate_task()
    print(f"Passed: {passed}")
    print(f"Feedback: {feedback}")
    print(f"Score: {score}")
