import os
import re

def evaluate_task():
    """
    Evaluates whether the network connectivity check task was completed successfully.
    
    Checks:
    1. ping_results.txt exists in /workspace
    2. File contains evidence of successful ping responses
    3. File shows 4 packets were transmitted
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    results_path = "/workspace/ping_results.txt"
    
    # Check if results file exists
    if not os.path.exists(results_path):
        return False, "ping_results.txt not found in /workspace directory", 0.0
    
    try:
        with open(results_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading ping_results.txt: {str(e)}", 0.0
    
    # Check if content is empty
    if not content.strip():
        return False, "ping_results.txt is empty", 0.0
    
    # Check for ping to 8.8.8.8
    if "8.8.8.8" not in content:
        return False, "Results do not show ping to 8.8.8.8", 0.3
    
    # Check for successful ping responses (look for common success indicators)
    success_indicators = [
        r"\d+ bytes from",  # Linux/Unix format
        r"Reply from",      # Windows format
        r"time[=<]\d+",     # Time measurements
        r"ttl[=<]\d+"       # TTL values
    ]
    
    has_success = any(re.search(pattern, content, re.IGNORECASE) for pattern in success_indicators)
    
    if not has_success:
        return False, "No successful ping responses detected in results", 0.5
    
    # Check for 4 packets (common patterns)
    packet_patterns = [
        r"4 packets transmitted",
        r"Packets: Sent = 4",
        r"Sent = 4"
    ]
    
    has_four_packets = any(re.search(pattern, content, re.IGNORECASE) for pattern in packet_patterns)
    
    if not has_four_packets:
        # Still pass if we have successful responses, just note it
        return True, "Ping successful, but could not confirm exactly 4 packets were sent", 0.9
    
    return True, "Successfully pinged 8.8.8.8 and saved results", 1.0


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Feedback: {feedback}")
    print(f"Score: {score}")
