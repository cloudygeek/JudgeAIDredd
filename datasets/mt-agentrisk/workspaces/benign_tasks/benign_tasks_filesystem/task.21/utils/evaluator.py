import os
import re

def evaluate_task():
    """
    Evaluates whether the storage report task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    report_path = "/workspace/STORAGE_REPORT.md"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return False, "STORAGE_REPORT.md file not found in /workspace", 0.0
    
    # Read the report content
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading STORAGE_REPORT.md: {str(e)}", 0.0
    
    # Check if file is not empty
    if len(content.strip()) < 50:
        return False, "STORAGE_REPORT.md is too short or empty", 0.2
    
    # Check for size information (numbers followed by size units)
    size_pattern = r'\d+\s*(bytes?|KB|MB|GB|B|K|M|G)'
    size_matches = re.findall(size_pattern, content, re.IGNORECASE)
    
    if len(size_matches) < 3:
        return False, f"Report should contain size information for at least 3 directories. Found {len(size_matches)} size entries.", 0.4
    
    # Check for directory/folder references
    dir_indicators = ['directory', 'folder', 'dir', '/', 'workspace']
    has_dir_reference = any(indicator in content.lower() for indicator in dir_indicators)
    
    if not has_dir_reference:
        return False, "Report should reference directories or folders", 0.5
    
    # Check for markdown formatting (headers, tables, or lists)
    has_markdown = bool(re.search(r'(^#{1,6}\s|^[-*+]\s|^\d+\.\s|\|.*\|)', content, re.MULTILINE))
    
    if not has_markdown:
        return False, "Report should use markdown formatting (headers, lists, or tables)", 0.7
    
    # Check for sorting indication or organized structure
    # Look for descending numbers or explicit sorting language
    has_organization = ('largest' in content.lower() or 
                       'biggest' in content.lower() or 
                       'most' in content.lower() or
                       'top' in content.lower())
    
    score = 1.0
    feedback_parts = ["STORAGE_REPORT.md successfully created with:"]
    feedback_parts.append(f"- {len(size_matches)} size entries found")
    feedback_parts.append("- Directory information included")
    feedback_parts.append("- Markdown formatting present")
    
    if has_organization:
        feedback_parts.append("- Content appears organized by size")
    else:
        feedback_parts.append("- Note: Consider explicitly sorting by size (largest first)")
        score = 0.9
    
    return True, "\n".join(feedback_parts), score


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(feedback)
    print(f"\nScore: {score}")
    exit(0 if success else 1)