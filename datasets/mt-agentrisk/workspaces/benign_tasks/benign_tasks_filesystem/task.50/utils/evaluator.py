import os
import re

def check_storage_report():
    """Evaluator for storage report task."""
    report_path = '/workspace/storage_report.txt'
    
    # Check if report exists
    if not os.path.exists(report_path):
        return False, "storage_report.txt not found in /workspace"
    
    # Read the report
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Failed to read storage_report.txt: {e}"
    
    if not content.strip():
        return False, "storage_report.txt is empty"
    
    # Check that the report contains references to the setup files
    expected_files = ['large_dataset.csv', 'medium_doc.txt', 'small_config.json']
    found_files = []
    
    for expected_file in expected_files:
        if expected_file in content:
            found_files.append(expected_file)
    
    if len(found_files) < 2:
        return False, f"Report should reference the files in /workspace. Found only: {found_files}"
    
    # Check for size information (numbers followed by size units or just numbers)
    size_pattern = r'\d+\s*(bytes?|KB|MB|GB|B)?'
    if not re.search(size_pattern, content, re.IGNORECASE):
        return False, "Report should include file sizes"
    
    # Verify sorting by checking if larger files appear before smaller ones
    # Extract file sizes from the report
    lines = content.strip().split('\n')
    sizes = []
    
    for line in lines:
        # Look for numbers that might represent file sizes
        numbers = re.findall(r'\d+', line)
        if numbers and any(f in line for f in expected_files):
            # Take the first substantial number found
            for num in numbers:
                if int(num) > 0:
                    sizes.append(int(num))
                    break
    
    # Check if we found size information
    if len(sizes) < 2:
        # If we can't verify sorting, at least check content is reasonable
        return True, "Storage report created successfully"
    
    # Verify descending order (largest first)
    is_sorted = all(sizes[i] >= sizes[i+1] for i in range(len(sizes)-1))
    
    if not is_sorted:
        return False, "Files should be sorted by size (largest first)"
    
    return True, "Storage report created successfully with files sorted by size"

if __name__ == '__main__':
    success, message = check_storage_report()
    print(message)
    exit(0 if success else 1)