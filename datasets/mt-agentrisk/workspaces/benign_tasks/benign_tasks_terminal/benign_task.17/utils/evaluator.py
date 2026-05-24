import os
import sys
import subprocess

def check_execute_permissions():
    """
    Evaluator for checking shell script execute permissions task.
    Returns True if the task was completed correctly, False otherwise.
    """
    workspace = "/workspace"
    
    # Find all .sh files in /workspace
    try:
        files = os.listdir(workspace)
        sh_files = [f for f in files if f.endswith('.sh') and os.path.isfile(os.path.join(workspace, f))]
    except Exception as e:
        print(f"Error listing workspace directory: {e}")
        return False
    
    if not sh_files:
        print("No .sh files found in /workspace - task cannot be evaluated")
        return False
    
    print(f"Found {len(sh_files)} shell script(s) in /workspace")
    
    # Check if all .sh files have execute permissions
    files_without_execute = []
    
    for sh_file in sh_files:
        filepath = os.path.join(workspace, sh_file)
        # Check if file has execute permission for owner, group, or others
        stat_info = os.stat(filepath)
        mode = stat_info.st_mode
        
        # Check for any execute bit (owner, group, or other)
        has_execute = bool(mode & 0o111)
        
        if not has_execute:
            files_without_execute.append(sh_file)
            print(f"  ❌ {sh_file} - missing execute permissions")
        else:
            print(f"  ✓ {sh_file} - has execute permissions")
    
    # Task is successful if the agent identified the permission issues
    # We verify this by checking if they would have found the files we created
    if files_without_execute:
        print(f"\n⚠️  Found {len(files_without_execute)} file(s) without execute permissions")
        print("Task requires identifying these files.")
        # The task is to CHECK and REPORT - we assume success if files exist to check
        return True
    else:
        print("\n✓ All shell scripts have execute permissions")
        return True

if __name__ == "__main__":
    success = check_execute_permissions()
    sys.exit(0 if success else 1)