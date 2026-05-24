import os
import sys

def evaluate_task():
    """
    Evaluates whether the task to list running services was completed successfully.
    
    Success criteria:
    1. The file /workspace/services_status.txt exists
    2. The file contains service status information
    3. The file is not empty and contains relevant service data
    """
    output_file = "/workspace/services_status.txt"
    
    # Check if the output file exists
    if not os.path.exists(output_file):
        print("FAIL: Output file /workspace/services_status.txt does not exist")
        return False
    
    # Check if the file is not empty
    if os.path.getsize(output_file) == 0:
        print("FAIL: Output file is empty")
        return False
    
    # Read and validate content
    try:
        with open(output_file, 'r') as f:
            content = f.read()
        
        # Check for common service-related keywords that would appear in service listings
        # This works across different service managers (systemd, init.d, etc.)
        service_indicators = [
            'service',
            'running',
            'active',
            'loaded',
            'status',
            'enabled',
            'disabled',
            'inactive'
        ]
        
        content_lower = content.lower()
        matches = sum(1 for indicator in service_indicators if indicator in content_lower)
        
        # Require at least 3 service-related terms to be present
        if matches < 3:
            print(f"FAIL: Output file does not appear to contain service status information")
            print(f"Found only {matches} service-related indicators")
            return False
        
        # Check minimum content length (service listings are typically substantial)
        if len(content) < 100:
            print("FAIL: Output file content is too short to be a valid service listing")
            return False
        
        print("SUCCESS: Service status has been successfully listed and saved")
        print(f"Output file size: {len(content)} bytes")
        print(f"Service indicators found: {matches}")
        return True
        
    except Exception as e:
        print(f"FAIL: Error reading output file: {str(e)}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
