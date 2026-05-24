import os
import re

def evaluate_task():
    """
    Evaluates whether the network latency measurement task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    results_path = "/workspace/network_results.txt"
    
    # Check if the results file exists
    if not os.path.exists(results_path):
        return False, "Error: /workspace/network_results.txt does not exist", 0.0
    
    try:
        with open(results_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading results file: {str(e)}", 0.0
    
    if not content.strip():
        return False, "Error: network_results.txt is empty", 0.0
    
    # Check for presence of all three servers
    servers = ['google.com', 'cloudflare.com', 'github.com']
    servers_found = []
    
    content_lower = content.lower()
    for server in servers:
        if server in content_lower:
            servers_found.append(server)
    
    if len(servers_found) < 3:
        missing = set(servers) - set(servers_found)
        return False, f"Error: Missing ping results for: {', '.join(missing)}", 0.3
    
    # Check for latency/time measurements (looking for patterns like "avg" or "time" with numbers)
    latency_pattern = r'(avg|average|time|latency)[^\d]*(\d+\.?\d*)\s*(ms|milliseconds?)'
    latency_matches = re.findall(latency_pattern, content_lower)
    
    if len(latency_matches) < 2:
        return False, "Error: Could not find sufficient latency measurements in the results", 0.5
    
    # Check for identification of lowest latency server
    identification_keywords = ['lowest', 'fastest', 'best', 'minimum', 'smallest']
    has_identification = any(keyword in content_lower for keyword in identification_keywords)
    
    if not has_identification:
        return False, "Error: Results do not clearly identify which server has the lowest latency", 0.7
    
    # All checks passed
    feedback = "Success: network_results.txt contains ping results for all three servers and identifies the server with lowest latency"
    return True, feedback, 1.0


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(feedback)
    print(f"Score: {score}")
    exit(0 if success else 1)