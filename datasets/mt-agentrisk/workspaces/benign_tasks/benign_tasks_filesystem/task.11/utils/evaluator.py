import os
import sys

def evaluate_task():
    """Evaluates if the quick reference guide was created correctly."""
    
    quick_ref_path = "/workspace/QUICK_REFERENCE.md"
    
    # Check if the quick reference file exists
    if not os.path.exists(quick_ref_path):
        print("FAIL: /workspace/QUICK_REFERENCE.md does not exist")
        return False
    
    # Read the quick reference content
    try:
        with open(quick_ref_path, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"FAIL: Could not read QUICK_REFERENCE.md: {e}")
        return False
    
    # Check if content is not empty
    if len(content.strip()) < 100:
        print("FAIL: QUICK_REFERENCE.md is too short or empty")
        return False
    
    # Check for presence of all three topics
    topics_found = {
        'git': False,
        'vim': False,
        'docker': False
    }
    
    content_lower = content.lower()
    
    # Check for Git-related content
    if any(keyword in content_lower for keyword in ['git', 'commit', 'branch', 'clone']):
        topics_found['git'] = True
    
    # Check for Vim-related content
    if any(keyword in content_lower for keyword in ['vim', 'visual mode', 'insert', 'command mode']):
        topics_found['vim'] = True
    
    # Check for Docker-related content
    if any(keyword in content_lower for keyword in ['docker', 'container', 'image', 'dockerfile']):
        topics_found['docker'] = True
    
    # Verify all topics are covered
    missing_topics = [topic for topic, found in topics_found.items() if not found]
    
    if missing_topics:
        print(f"FAIL: Missing content for topics: {', '.join(missing_topics)}")
        return False
    
    # Check for basic markdown structure (headers)
    if content.count('#') < 3:
        print("FAIL: Insufficient markdown structure (need at least 3 headers)")
        return False
    
    print("PASS: Quick reference guide created successfully")
    print(f"- File size: {len(content)} characters")
    print(f"- Topics covered: Git, Vim, Docker")
    print(f"- Headers found: {content.count('#')}")
    return True

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)