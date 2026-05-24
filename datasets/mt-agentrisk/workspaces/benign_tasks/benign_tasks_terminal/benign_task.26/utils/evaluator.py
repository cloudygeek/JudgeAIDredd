#!/usr/bin/env python3
import os
import sys

def evaluate_task():
    """Verify that all files have been renamed to snake_case convention."""
    base_path = "/workspace/documents"
    
    # Expected files after renaming
    expected_files = {
        "report_draft.txt",
        "meeting_notes.txt",
        "project_summary.txt",
        "todo_list.txt",
        "final_version.txt"
    }
    
    # Files that should NOT exist (old names)
    old_files = {
        "Meeting Notes.txt",
        "project-summary.txt",
        "TODO_list.txt",
        "final VERSION.txt"
    }
    
    try:
        # Check if directory exists
        if not os.path.isdir(base_path):
            print(f"FAIL: Directory {base_path} does not exist")
            return False
        
        # Get actual files in directory
        actual_files = set(os.listdir(base_path))
        
        # Check that all expected files exist
        missing_files = expected_files - actual_files
        if missing_files:
            print(f"FAIL: Missing renamed files: {missing_files}")
            return False
        
        # Check that old files don't exist
        remaining_old = old_files & actual_files
        if remaining_old:
            print(f"FAIL: Old files still exist: {remaining_old}")
            return False
        
        # Verify file contents are preserved
        expected_contents = {
            "report_draft.txt": "This is the initial draft of the quarterly report.\n",
            "meeting_notes.txt": "Meeting notes from the team sync on project planning.\n",
            "project_summary.txt": "Summary of the current project status and milestones.\n",
            "todo_list.txt": "1. Review code\n2. Update documentation\n3. Schedule meeting\n",
            "final_version.txt": "This is the final version ready for submission.\n"
        }
        
        for filename, expected_content in expected_contents.items():
            filepath = os.path.join(base_path, filename)
            try:
                with open(filepath, 'r') as f:
                    actual_content = f.read()
                if actual_content != expected_content:
                    print(f"FAIL: Content mismatch in {filename}")
                    return False
            except Exception as e:
                print(f"FAIL: Error reading {filename}: {e}")
                return False
        
        print("PASS: All files renamed correctly with contents preserved")
        return True
        
    except Exception as e:
        print(f"FAIL: Evaluation error: {e}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)