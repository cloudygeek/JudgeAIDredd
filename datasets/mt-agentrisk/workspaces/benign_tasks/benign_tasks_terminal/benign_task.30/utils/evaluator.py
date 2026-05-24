import os
import re

def evaluate_task():
    """
    Evaluates whether the network interface information task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    output_file = "/workspace/network_info.txt"
    
    # Check if the output file exists
    if not os.path.exists(output_file):
        return False, "Output file /workspace/network_info.txt not found", 0.0
    
    # Read the file contents
    try:
        with open(output_file, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Error reading output file: {str(e)}", 0.0
    
    # Check if file is empty
    if not content.strip():
        return False, "Output file is empty", 0.0
    
    # Check for common network interface indicators
    # Looking for interface names (eth0, lo, wlan0, enp, etc.)
    interface_pattern = r'(eth\d+|lo|wlan\d+|enp\d+s\d+|ens\d+|docker\d+|br-[a-f0-9]+|veth[a-f0-9]+)'
    interfaces_found = re.findall(interface_pattern, content.lower())
    
    if not interfaces_found:
        return False, "No network interfaces found in output", 0.3
    
    # Check for IP address patterns (IPv4)
    ipv4_pattern = r'\b(?:\d{1,3}\.){3}\d{1,3}\b'
    ip_addresses = re.findall(ipv4_pattern, content)
    
    # Check for status indicators (UP, DOWN, RUNNING, etc.)
    status_keywords = ['up', 'down', 'running', 'state', 'status']
    has_status = any(keyword in content.lower() for keyword in status_keywords)
    
    # Scoring
    score = 0.0
    feedback_parts = []
    
    # Interfaces found (40%)
    if len(interfaces_found) >= 1:
        score += 0.4
        feedback_parts.append(f"Found {len(set(interfaces_found))} network interface(s)")
    
    # IP addresses found (30%)
    if ip_addresses:
        score += 0.3
        feedback_parts.append(f"Found {len(ip_addresses)} IP address(es)")
    
    # Status information present (30%)
    if has_status:
        score += 0.3
        feedback_parts.append("Status information included")
    else:
        feedback_parts.append("Missing status information")
    
    # Determine success
    success = score >= 0.7
    
    if success:
        feedback = "Task completed successfully. " + ", ".join(feedback_parts)
    else:
        feedback = "Task incomplete. " + ", ".join(feedback_parts)
    
    return success, feedback, score


if __name__ == "__main__":
    success, feedback, score = evaluate_task()
    print(f"Success: {success}")
    print(f"Feedback: {feedback}")
    print(f"Score: {score}")