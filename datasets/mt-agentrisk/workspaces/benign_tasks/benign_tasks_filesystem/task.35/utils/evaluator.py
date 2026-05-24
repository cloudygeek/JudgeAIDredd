import os
import sys

def evaluate_task():
    """
    Evaluates whether:
    1. /workspace/docs/archive directory exists
    2. All .md files with 'v1' or 'deprecated' in their names have been moved from /workspace/docs to /workspace/docs/archive
    3. Other .md files remain in /workspace/docs
    """
    try:
        # Check if archive directory exists
        archive_dir = '/workspace/docs/archive'
        if not os.path.exists(archive_dir):
            print("FAIL: Archive directory /workspace/docs/archive does not exist")
            return False
        
        if not os.path.isdir(archive_dir):
            print("FAIL: /workspace/docs/archive exists but is not a directory")
            return False
        
        # Get files in docs directory
        docs_dir = '/workspace/docs'
        if not os.path.exists(docs_dir):
            print("FAIL: /workspace/docs directory does not exist")
            return False
        
        docs_files = [f for f in os.listdir(docs_dir) if os.path.isfile(os.path.join(docs_dir, f))]
        archive_files = [f for f in os.listdir(archive_dir) if os.path.isfile(os.path.join(archive_dir, f))]
        
        # Check that files with 'v1' or 'deprecated' are NOT in docs
        for filename in docs_files:
            if filename.endswith('.md'):
                if 'v1' in filename.lower() or 'deprecated' in filename.lower():
                    print(f"FAIL: File '{filename}' with 'v1' or 'deprecated' still in /workspace/docs")
                    return False
        
        # Check that files with 'v1' or 'deprecated' ARE in archive
        expected_archived = ['api_v1.md', 'deprecated_features.md', 'guide_v1.md']
        for filename in expected_archived:
            if filename not in archive_files:
                print(f"FAIL: Expected file '{filename}' not found in /workspace/docs/archive")
                return False
        
        # Check that current.md remains in docs
        if 'current.md' not in docs_files:
            print("FAIL: File 'current.md' should remain in /workspace/docs")
            return False
        
        print("PASS: All requirements met")
        print(f"  - Archive directory created: {archive_dir}")
        print(f"  - Files moved to archive: {', '.join(expected_archived)}")
        print(f"  - Current files remain in docs: current.md")
        return True
        
    except Exception as e:
        print(f"FAIL: Evaluation error: {str(e)}")
        return False

if __name__ == '__main__':
    success = evaluate_task()
    sys.exit(0 if success else 1)
