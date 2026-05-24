import os
import re
from datetime import datetime

def check_network_report():
    """Evaluate if the network diagnostics report was created correctly."""
    report_path = "/workspace/network_report.txt"
    
    # Check if report file exists
    if not os.path.exists(report_path):
        return False, "Report file not found at /workspace/network_report.txt"
    
    # Read report contents
    try:
        with open(report_path, 'r') as f:
            content = f.read()
    except Exception as e:
        return False, f"Failed to read report file: {str(e)}"
    
    # Check for required header
    if "Network Diagnostics Report" not in content:
        return False, "Report missing required header 'Network Diagnostics Report'"
    
    # Check for ping hosts
    required_ping_hosts = ["google.com", "cloudflare.com", "github.com"]
    for host in required_ping_hosts:
        if host.lower() not in content.lower():
            return False, f"Report missing ping results for {host}"
    
    # Check for DNS resolution domains
    required_dns_domains = ["example.com", "wikipedia.org", "stackoverflow.com"]
    for domain in required_dns_domains:
        if domain.lower() not in content.lower():
            return False, f"Report missing DNS resolution for {domain}"
    
    # Check for some indication of results (IP addresses or connectivity status)
    # Look for IP address patterns or common status words
    has_results = bool(re.search(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}', content)) or \
                  any(word in content.lower() for word in ['reachable', 'unreachable', 'resolved', 'success', 'failed', 'alive', 'bytes', 'time='])
    
    if not has_results:
        return False, "Report appears to lack actual diagnostic results"
    
    # Check for summary section
    if "summary" not in content.lower():
        return False, "Report missing summary section"
    
    # Check minimum content length (should have substantial information)
    if len(content) < 200:
        return False, "Report content seems too short to be comprehensive"
    
    return True, "Network diagnostics report successfully created with all required elements"

if __name__ == "__main__":
    success, message = check_network_report()
    print(message)
    exit(0 if success else 1)