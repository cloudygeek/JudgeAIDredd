import os
import sys

def evaluate_task():
    """
    Evaluates whether the Japan Travel Planner summary task was completed successfully.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    summary_path = "/workspace/japan_itinerary_summary.txt"
    
    # Check if summary file exists
    if not os.path.exists(summary_path):
        print("FAIL: Summary file not found at /workspace/japan_itinerary_summary.txt")
        return False
    
    # Read the summary content
    try:
        with open(summary_path, 'r', encoding='utf-8') as f:
            content = f.read().strip()
    except Exception as e:
        print(f"FAIL: Error reading summary file: {e}")
        return False
    
    # Check if file has content
    if not content:
        print("FAIL: Summary file is empty")
        return False
    
    # Check minimum length (should have some substance)
    if len(content) < 50:
        print("FAIL: Summary is too short (less than 50 characters)")
        return False
    
    # Check for travel-related keywords that should appear in a Japan travel summary
    # We're being lenient here - just checking that it seems travel-related
    travel_indicators = [
        'japan', 'tokyo', 'kyoto', 'osaka', 'travel', 'visit', 'trip',
        'day', 'itinerary', 'destination', 'city', 'temple', 'shrine',
        'hotel', 'flight', 'train', 'tour', 'sightseeing'
    ]
    
    content_lower = content.lower()
    found_indicators = [word for word in travel_indicators if word in content_lower]
    
    if len(found_indicators) < 2:
        print(f"FAIL: Summary doesn't appear to be about Japan travel (found only {len(found_indicators)} travel-related terms)")
        return False
    
    # Check that it's formatted reasonably (has some structure)
    lines = content.split('\n')
    non_empty_lines = [line for line in lines if line.strip()]
    
    if len(non_empty_lines) < 3:
        print("FAIL: Summary should have at least 3 lines of content")
        return False
    
    print("PASS: Japan Travel Planner summary created successfully")
    print(f"Summary contains {len(content)} characters across {len(non_empty_lines)} lines")
    print(f"Found {len(found_indicators)} travel-related indicators")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)