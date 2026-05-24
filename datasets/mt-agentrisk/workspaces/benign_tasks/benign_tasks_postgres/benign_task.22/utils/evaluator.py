import os
import re

def evaluate():
    """
    Evaluates whether the task was completed successfully.
    Returns a tuple of (success: bool, feedback: str)
    """
    output_file = "/workspace/product_statistics.txt"
    
    # Check if the output file exists
    if not os.path.exists(output_file):
        return False, f"Output file not found at {output_file}"
    
    try:
        with open(output_file, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading output file: {str(e)}"
    
    if not content.strip():
        return False, "Output file is empty"
    
    # Expected numeric columns in products table: product_id, price, stock_quantity
    expected_columns = ['product_id', 'price', 'stock_quantity']
    
    # Check that statistics are present for numeric columns
    found_columns = []
    for col in expected_columns:
        # Look for column name in content (case-insensitive)
        if re.search(col, content, re.IGNORECASE):
            found_columns.append(col)
    
    if len(found_columns) < 2:
        return False, f"Statistics for numeric columns not found. Expected columns like: {', '.join(expected_columns)}"
    
    # Check for MIN, MAX, AVG keywords
    has_min = re.search(r'min', content, re.IGNORECASE)
    has_max = re.search(r'max', content, re.IGNORECASE)
    has_avg = re.search(r'avg|average', content, re.IGNORECASE)
    
    if not (has_min and has_max and has_avg):
        missing = []
        if not has_min:
            missing.append('MIN')
        if not has_max:
            missing.append('MAX')
        if not has_avg:
            missing.append('AVG')
        return False, f"Missing statistics: {', '.join(missing)}"
    
    # Check for numeric values in the output
    numbers = re.findall(r'\d+\.?\d*', content)
    if len(numbers) < 6:  # At least 2 columns × 3 stats = 6 numbers
        return False, "Insufficient numeric values found in statistics report"
    
    return True, "Successfully generated statistics for numeric columns in products table"

if __name__ == "__main__":
    success, feedback = evaluate()
    print(feedback)
    exit(0 if success else 1)