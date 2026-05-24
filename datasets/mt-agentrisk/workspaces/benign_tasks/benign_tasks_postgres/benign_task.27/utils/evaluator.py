import os
import re

def evaluate_task():
    """
    Evaluates whether the data quality check task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    report_path = "/workspace/data_quality_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return False, "Data quality report file not found at /workspace/data_quality_report.txt", 0.0
    
    try:
        with open(report_path, 'r') as f:
            content = f.read().lower()
        
        if not content.strip():
            return False, "Report file is empty", 0.0
        
        score = 0.0
        feedback_parts = []
        
        # Check for users table analysis (25 points)
        if 'users' in content or 'email' in content:
            score += 25
            feedback_parts.append("✓ Users table analysis present")
        else:
            feedback_parts.append("✗ Missing users table analysis")
        
        # Check for products table analysis (25 points)
        if 'products' in content or 'price' in content:
            score += 25
            feedback_parts.append("✓ Products table analysis present")
        else:
            feedback_parts.append("✗ Missing products table analysis")
        
        # Check for orders table analysis (25 points)
        if 'orders' in content or 'total_amount' in content:
            score += 25
            feedback_parts.append("✓ Orders table analysis present")
        else:
            feedback_parts.append("✗ Missing orders table analysis")
        
        # Check for mentions of key quality issues (25 points)
        quality_keywords = ['null', 'duplicate', 'anomal', 'issue', 'count', 'found']
        keyword_matches = sum(1 for keyword in quality_keywords if keyword in content)
        
        if keyword_matches >= 3:
            score += 25
            feedback_parts.append("✓ Quality check findings documented")
        else:
            feedback_parts.append("✗ Insufficient quality check documentation")
        
        feedback = "\n".join(feedback_parts)
        success = score >= 75  # Need at least 75% to pass
        
        return success, feedback, score / 100.0
        
    except Exception as e:
        return False, f"Error reading report file: {str(e)}", 0.0

if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Score: {score:.2%}")
    print(f"Feedback:\n{feedback}")