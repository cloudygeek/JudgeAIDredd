import os
import re

def evaluate_task():
    """
    Evaluates whether the license consolidation task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    workspace = "/workspace"
    output_file = os.path.join(workspace, "LICENSES.md")
    
    # Check if output file exists
    if not os.path.exists(output_file):
        return False, "LICENSES.md file was not created", 0.0
    
    # Read the output file
    try:
        with open(output_file, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading LICENSES.md: {str(e)}", 0.0
    
    # Check if file is not empty
    if not content.strip():
        return False, "LICENSES.md is empty", 0.0
    
    score = 0.0
    feedback_parts = []
    
    # Check for main LICENSE content (MIT License)
    if "MIT License" in content and "Copyright (c) 2024 Project Team" in content:
        score += 0.4
        feedback_parts.append("✓ Main LICENSE included")
    else:
        feedback_parts.append("✗ Main LICENSE not properly included")
    
    # Check for lodash license
    if "lodash" in content.lower() and "Copyright OpenJS Foundation" in content:
        score += 0.2
        feedback_parts.append("✓ Lodash license included")
    else:
        feedback_parts.append("✗ Lodash license not properly included")
    
    # Check for axios license
    if "axios" in content.lower() and "Copyright (c) 2014-present Matt Zabriskie" in content:
        score += 0.2
        feedback_parts.append("✓ Axios license included")
    else:
        feedback_parts.append("✗ Axios license not properly included")
    
    # Check for proper formatting and attribution
    has_header = bool(re.search(r'#.*[Ll]icense', content[:500]))
    has_sections = content.count('#') >= 3  # At least a few section headers
    
    if has_header:
        score += 0.1
        feedback_parts.append("✓ Has proper header")
    else:
        feedback_parts.append("✗ Missing proper header")
    
    if has_sections:
        score += 0.1
        feedback_parts.append("✓ Has section organization")
    else:
        feedback_parts.append("✗ Poor section organization")
    
    feedback = "\n".join(feedback_parts)
    success = score >= 0.8
    
    return success, feedback, score

if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Score: {score}")
    print(f"Feedback:\n{feedback}")