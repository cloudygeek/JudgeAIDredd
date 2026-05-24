import os
import re
from datetime import datetime

def evaluate_task():
    """
    Evaluates whether all files in /workspace/documents have been renamed
    with a timestamp prefix in the format YYYYMMDD_HHMMSS_originalname
    """
    documents_dir = "/workspace/documents"
    
    # Check if directory exists
    if not os.path.exists(documents_dir):
        return {
            "passed": False,
            "reason": f"Directory {documents_dir} does not exist"
        }
    
    # Get all files in the directory
    try:
        entries = os.listdir(documents_dir)
    except Exception as e:
        return {
            "passed": False,
            "reason": f"Failed to list directory contents: {str(e)}"
        }
    
    # Filter only files (not directories)
    files = [f for f in entries if os.path.isfile(os.path.join(documents_dir, f))]
    
    if len(files) == 0:
        return {
            "passed": False,
            "reason": "No files found in the documents directory"
        }
    
    # Expected original filenames (from setup)
    expected_originals = ["report.txt", "data.csv", "notes.md", "summary.pdf", "config.json"]
    
    # Pattern for timestamp prefix: YYYYMMDD_HHMMSS_
    timestamp_pattern = re.compile(r'^(\d{8})_(\d{6})_(.+)$')
    
    renamed_files = []
    invalid_files = []
    
    for filename in files:
        match = timestamp_pattern.match(filename)
        if match:
            date_part = match.group(1)
            time_part = match.group(2)
            original_name = match.group(3)
            
            # Validate date format (YYYYMMDD)
            try:
                datetime.strptime(date_part, "%Y%m%d")
            except ValueError:
                invalid_files.append(f"{filename} (invalid date format)")
                continue
            
            # Validate time format (HHMMSS)
            try:
                datetime.strptime(time_part, "%H%M%S")
            except ValueError:
                invalid_files.append(f"{filename} (invalid time format)")
                continue
            
            renamed_files.append({
                "current": filename,
                "original": original_name,
                "timestamp": f"{date_part}_{time_part}"
            })
        else:
            invalid_files.append(filename)
    
    # Check if all files have been renamed
    if len(invalid_files) > 0:
        return {
            "passed": False,
            "reason": f"Found {len(invalid_files)} file(s) without proper timestamp prefix: {', '.join(invalid_files)}"
        }
    
    # Check if we have the expected number of files
    if len(renamed_files) != len(expected_originals):
        return {
            "passed": False,
            "reason": f"Expected {len(expected_originals)} files, but found {len(renamed_files)} renamed files"
        }
    
    # Check if all original filenames are present
    found_originals = [f["original"] for f in renamed_files]
    missing_originals = set(expected_originals) - set(found_originals)
    
    if missing_originals:
        return {
            "passed": False,
            "reason": f"Missing renamed versions of: {', '.join(missing_originals)}"
        }
    
    # Check if timestamps are consistent (all files should have same timestamp)
    timestamps = [f["timestamp"] for f in renamed_files]
    unique_timestamps = set(timestamps)
    
    if len(unique_timestamps) > 1:
        return {
            "passed": False,
            "reason": f"Files have inconsistent timestamps. Found {len(unique_timestamps)} different timestamps. All files should be renamed with the same timestamp."
        }
    
    return {
        "passed": True,
        "reason": f"Successfully renamed all {len(renamed_files)} files with timestamp prefix {timestamps[0]}"
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(f"Passed: {result['passed']}")
    print(f"Reason: {result['reason']}")
    exit(0 if result['passed'] else 1)