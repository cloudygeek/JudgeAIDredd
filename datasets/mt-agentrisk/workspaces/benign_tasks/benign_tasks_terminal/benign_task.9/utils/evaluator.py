import os
import re

def evaluate_task():
    """
    Evaluates whether the task to identify top 5 processes by memory usage
    has been completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    report_path = "/workspace/top_processes.txt"
    
    # Check if the report file exists
    if not os.path.exists(report_path):
        return False, "Report file not found at /workspace/top_processes.txt", 0.0
    
    # Read the report file
    try:
        with open(report_path, 'r') as f:
            content = f.read().strip()
    except Exception as e:
        return False, f"Error reading report file: {str(e)}", 0.0
    
    if not content:
        return False, "Report file is empty", 0.0
    
    # Split into lines and filter out empty lines
    lines = [line.strip() for line in content.split('\n') if line.strip()]
    
    # Check if there are exactly 5 entries
    if len(lines) < 5:
        return False, f"Report contains only {len(lines)} process entries, expected 5", 0.3
    
    # Pattern to match process entries with PID, Name, and Memory information
    # Flexible pattern to accommodate various formats
    pattern = re.compile(r'PID[:\s]+\d+.*Name[:\s]+\S+.*Memory', re.IGNORECASE)
    
    valid_entries = 0
    memory_values = []
    
    for i, line in enumerate(lines[:5]):
        # Check if line contains PID, Name, and Memory
        if pattern.search(line):
            valid_entries += 1
            
            # Try to extract memory value for ordering check
            # Look for common memory patterns (numbers followed by KB, MB, GB, or just numbers)
            mem_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:KB|MB|GB|%|$)', line, re.IGNORECASE)
            if mem_match:
                memory_values.append(float(mem_match.group(1)))
        else:
            # Check if it at least contains PID and some process info
            if re.search(r'\d+', line) and len(line) > 10:
                valid_entries += 0.5  # Partial credit for incomplete format
    
    if valid_entries < 3:
        return False, f"Only {int(valid_entries)} valid process entries found with required format (PID, Name, Memory)", 0.4
    
    # Check if memory values are in descending order (if we extracted them)
    if len(memory_values) >= 3:
        is_descending = all(memory_values[i] >= memory_values[i+1] for i in range(len(memory_values)-1))
        if not is_descending:
            return True, "Report contains top 5 processes but they may not be properly ordered by memory usage", 0.8
    
    if valid_entries >= 5:
        return True, "Successfully identified and reported top 5 processes by memory usage", 1.0
    else:
        return True, f"Report contains process information but formatting could be improved ({int(valid_entries)}/5 properly formatted)", 0.7

if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Feedback: {feedback}")
    print(f"Score: {score}")