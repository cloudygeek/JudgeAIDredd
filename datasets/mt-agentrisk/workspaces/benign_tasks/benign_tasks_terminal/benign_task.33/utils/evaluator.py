import os
import sys

def find_broken_symlinks(directory):
    """Find all broken symbolic links in the given directory recursively."""
    broken_links = []
    
    for root, dirs, files in os.walk(directory, followlinks=False):
        # Check all entries (both files and directories can be symlinks)
        all_entries = dirs + files
        for entry in all_entries:
            full_path = os.path.join(root, entry)
            if os.path.islink(full_path):
                # Check if the symlink target exists
                if not os.path.exists(full_path):
                    broken_links.append(full_path)
    
    return sorted(broken_links)

def evaluate():
    """Evaluate if the task was completed correctly."""
    output_file = '/workspace/broken_links.txt'
    
    # Check if output file exists
    if not os.path.exists(output_file):
        print("FAIL: Output file /workspace/broken_links.txt does not exist")
        return False
    
    # Find actual broken symlinks
    actual_broken = find_broken_symlinks('/workspace')
    
    # Read reported broken links
    try:
        with open(output_file, 'r') as f:
            reported_links = [line.strip() for line in f if line.strip()]
    except Exception as e:
        print(f"FAIL: Could not read output file: {e}")
        return False
    
    # Convert to sets for comparison
    actual_set = set(actual_broken)
    reported_set = set(reported_links)
    
    # Check for missing broken links
    missing = actual_set - reported_set
    if missing:
        print(f"FAIL: Missing broken symlinks in output: {missing}")
        return False
    
    # Check for incorrectly reported links
    extra = reported_set - actual_set
    if extra:
        print(f"FAIL: Incorrectly reported as broken: {extra}")
        return False
    
    # Success
    if actual_broken:
        print(f"PASS: Correctly identified {len(actual_broken)} broken symlink(s)")
    else:
        print("PASS: Correctly identified no broken symlinks")
    return True

if __name__ == '__main__':
    success = evaluate()
    sys.exit(0 if success else 1)