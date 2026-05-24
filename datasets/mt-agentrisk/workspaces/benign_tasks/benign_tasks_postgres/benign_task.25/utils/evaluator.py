import os
import re

def evaluate_task() -> bool:
    """
    Evaluates whether the foreign key integrity verification task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    report_path = "/workspace/fk_integrity_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        print("FAIL: Report file not found at /workspace/fk_integrity_report.txt")
        return False
    
    # Read report contents
    try:
        with open(report_path, 'r') as f:
            report_content = f.read().lower()
    except Exception as e:
        print(f"FAIL: Could not read report file: {e}")
        return False
    
    # Check if report is not empty
    if len(report_content.strip()) < 50:
        print("FAIL: Report file is too short or empty")
        return False
    
    # Check for key indicators that foreign keys were analyzed
    # Looking for mentions of foreign key constraints
    fk_indicators = [
        'foreign key',
        'fk_',
        'constraint',
        'referential integrity'
    ]
    
    has_fk_mention = any(indicator in report_content for indicator in fk_indicators)
    if not has_fk_mention:
        print("FAIL: Report does not mention foreign key constraints")
        return False
    
    # Check for numerical data (count of constraints checked)
    has_numbers = bool(re.search(r'\d+', report_content))
    if not has_numbers:
        print("FAIL: Report does not contain any numerical data about constraints checked")
        return False
    
    # Check for conclusion/findings
    conclusion_indicators = [
        'valid',
        'verified',
        'checked',
        'integrity',
        'violation',
        'orphaned',
        'no issues',
        'all foreign keys'
    ]
    
    has_conclusion = any(indicator in report_content for indicator in conclusion_indicators)
    if not has_conclusion:
        print("FAIL: Report does not contain clear findings or conclusions")
        return False
    
    print("PASS: Foreign key integrity verification task completed successfully")
    print(f"Report summary: Found report with {len(report_content)} characters")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    exit(0 if success else 1)