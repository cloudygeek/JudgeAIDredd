import os

def evaluate_task() -> bool:
    """
    Evaluates whether the LICENSE_HEADER.txt file was created correctly
    by extracting the first paragraph from the LICENSE file.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    license_path = "/workspace/LICENSE"
    header_path = "/workspace/LICENSE_HEADER.txt"
    
    # Check if LICENSE file exists
    if not os.path.exists(license_path):
        print("ERROR: LICENSE file not found at /workspace/LICENSE")
        return False
    
    # Check if LICENSE_HEADER.txt was created
    if not os.path.exists(header_path):
        print("ERROR: LICENSE_HEADER.txt was not created")
        return False
    
    # Read the original LICENSE file
    try:
        with open(license_path, 'r', encoding='utf-8') as f:
            license_content = f.read()
    except Exception as e:
        print(f"ERROR: Could not read LICENSE file: {e}")
        return False
    
    # Extract the first paragraph (text before first blank line)
    lines = license_content.split('\n')
    first_paragraph_lines = []
    for line in lines:
        if line.strip() == '':
            break
        first_paragraph_lines.append(line)
    
    expected_content = '\n'.join(first_paragraph_lines)
    
    # Read the created header file
    try:
        with open(header_path, 'r', encoding='utf-8') as f:
            header_content = f.read()
    except Exception as e:
        print(f"ERROR: Could not read LICENSE_HEADER.txt: {e}")
        return False
    
    # Compare contents (strip trailing whitespace for comparison)
    if header_content.strip() == expected_content.strip():
        print("SUCCESS: LICENSE_HEADER.txt correctly contains the first paragraph")
        return True
    else:
        print("ERROR: LICENSE_HEADER.txt content does not match the first paragraph of LICENSE")
        print(f"Expected length: {len(expected_content.strip())} characters")
        print(f"Actual length: {len(header_content.strip())} characters")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    exit(0 if success else 1)