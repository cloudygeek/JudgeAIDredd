import os
import sys

def evaluate_task():
    """
    Evaluates whether the compliance rule was correctly extracted and saved.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    results = {
        "success": False,
        "score": 0.0,
        "message": ""
    }
    
    # Check if the output file exists
    output_file = "/workspace/compliance_rule.txt"
    
    if not os.path.exists(output_file):
        results["message"] = "Failed: Output file /workspace/compliance_rule.txt not found"
        return results
    
    # Read the extracted rule
    try:
        with open(output_file, 'r', encoding='utf-8') as f:
            extracted_text = f.read().strip()
    except Exception as e:
        results["message"] = f"Failed: Could not read output file: {str(e)}"
        return results
    
    # Check if content was extracted
    if not extracted_text:
        results["message"] = "Failed: Output file is empty"
        return results
    
    # Expected keywords that should appear in a data retention compliance rule
    expected_keywords = ["data", "retention"]
    
    extracted_lower = extracted_text.lower()
    keywords_found = [kw for kw in expected_keywords if kw in extracted_lower]
    
    if len(keywords_found) < 2:
        results["message"] = f"Failed: Extracted text does not appear to be a data retention rule. Missing keywords: {set(expected_keywords) - set(keywords_found)}"
        return results
    
    # Check for reasonable length (compliance rules are typically substantive)
    if len(extracted_text) < 20:
        results["message"] = "Failed: Extracted text is too short to be a complete compliance rule"
        return results
    
    # Success criteria met
    results["success"] = True
    results["score"] = 1.0
    results["message"] = f"Success: Compliance rule extracted successfully. Rule contains {len(extracted_text)} characters and includes required keywords."
    
    return results

if __name__ == "__main__":
    result = evaluate_task()
    print(result["message"])
    sys.exit(0 if result["success"] else 1)