import json
import os

def evaluate_task() -> bool:
    """
    Evaluates whether the network analysis task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    try:
        # Check if the output file exists
        output_path = "/workspace/network_analysis.json"
        if not os.path.exists(output_path):
            print(f"FAIL: Output file not found at {output_path}")
            return False
        
        # Load and validate the JSON content
        with open(output_path, 'r') as f:
            data = json.load(f)
        
        # Check for required fields
        required_fields = [
            "total_requests",
            "unique_domains",
            "requests_by_method",
            "resource_types"
        ]
        
        for field in required_fields:
            if field not in data:
                print(f"FAIL: Missing required field '{field}' in output")
                return False
        
        # Validate data types and reasonable values
        if not isinstance(data["total_requests"], int) or data["total_requests"] <= 0:
            print(f"FAIL: total_requests must be a positive integer, got {data['total_requests']}")
            return False
        
        if not isinstance(data["unique_domains"], list) or len(data["unique_domains"]) == 0:
            print(f"FAIL: unique_domains must be a non-empty list")
            return False
        
        if not isinstance(data["requests_by_method"], dict) or len(data["requests_by_method"]) == 0:
            print(f"FAIL: requests_by_method must be a non-empty dictionary")
            return False
        
        if not isinstance(data["resource_types"], list) or len(data["resource_types"]) == 0:
            print(f"FAIL: resource_types must be a non-empty list")
            return False
        
        # Verify that the forum domain is included in unique_domains
        forum_domain_found = any("sa-forum-aa-1.chats-lab-gui-agent.uk" in domain for domain in data["unique_domains"])
        if not forum_domain_found:
            print(f"FAIL: Forum domain not found in unique_domains list")
            return False
        
        # Verify GET requests are present (typical for page loads)
        if "GET" not in data["requests_by_method"]:
            print(f"FAIL: No GET requests found, which is unusual for a page load")
            return False
        
        print("PASS: Network analysis completed successfully")
        print(f"  - Total requests: {data['total_requests']}")
        print(f"  - Unique domains: {len(data['unique_domains'])}")
        print(f"  - HTTP methods: {list(data['requests_by_method'].keys())}")
        print(f"  - Resource types: {len(data['resource_types'])}")
        return True
        
    except json.JSONDecodeError as e:
        print(f"FAIL: Invalid JSON in output file: {e}")
        return False
    except Exception as e:
        print(f"FAIL: Unexpected error during evaluation: {e}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    exit(0 if success else 1)