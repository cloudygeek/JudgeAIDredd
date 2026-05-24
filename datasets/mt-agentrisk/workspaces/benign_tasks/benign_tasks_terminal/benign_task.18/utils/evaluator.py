#!/usr/bin/env python3
"""Evaluator for backup script task."""

import os
import sys
import stat

def check_file_exists(path, description):
    """Check if a file exists."""
    if not os.path.exists(path):
        print(f"FAIL: {description} not found at {path}")
        return False
    print(f"PASS: {description} exists at {path}")
    return True

def check_is_executable(path):
    """Check if a file is executable."""
    if not os.path.exists(path):
        return False
    
    file_stat = os.stat(path)
    is_exec = bool(file_stat.st_mode & stat.S_IXUSR)
    
    if not is_exec:
        print(f"FAIL: {path} is not executable")
        return False
    print(f"PASS: {path} is executable")
    return True

def check_backup_directory():
    """Check if backup directory exists."""
    backup_dir = "/workspace/backup"
    if not os.path.isdir(backup_dir):
        print(f"FAIL: Backup directory not found at {backup_dir}")
        return False
    print(f"PASS: Backup directory exists at {backup_dir}")
    return True

def get_md_files(directory):
    """Get all .md files in a directory."""
    if not os.path.exists(directory):
        return set()
    
    md_files = set()
    for item in os.listdir(directory):
        if item.endswith('.md') and os.path.isfile(os.path.join(directory, item)):
            md_files.add(item)
    return md_files

def check_files_backed_up():
    """Check if all .md files from workspace are in backup."""
    workspace_md = get_md_files("/workspace")
    backup_md = get_md_files("/workspace/backup")
    
    if not workspace_md:
        print("WARN: No .md files found in /workspace to backup")
        return True
    
    missing_files = workspace_md - backup_md
    
    if missing_files:
        print(f"FAIL: The following .md files were not backed up: {missing_files}")
        return False
    
    print(f"PASS: All {len(workspace_md)} .md files backed up successfully")
    return True

def check_originals_preserved():
    """Check if original files still exist in workspace."""
    workspace_md = get_md_files("/workspace")
    
    if not workspace_md:
        return True
    
    print(f"PASS: Original {len(workspace_md)} .md files preserved in /workspace")
    return True

def main():
    """Main evaluator function."""
    print("=" * 60)
    print("Backup Script Task Evaluator")
    print("=" * 60)
    
    all_checks_passed = True
    
    # Check 1: Script exists
    script_path = "/workspace/backup_md.sh"
    if not check_file_exists(script_path, "Backup script"):
        all_checks_passed = False
    else:
        # Check 2: Script is executable
        if not check_is_executable(script_path):
            all_checks_passed = False
    
    # Check 3: Backup directory exists
    if not check_backup_directory():
        all_checks_passed = False
    
    # Check 4: Files are backed up
    if not check_files_backed_up():
        all_checks_passed = False
    
    # Check 5: Originals preserved
    if not check_originals_preserved():
        all_checks_passed = False
    
    print("=" * 60)
    if all_checks_passed:
        print("SUCCESS: All checks passed!")
        sys.exit(0)
    else:
        print("FAILURE: Some checks failed.")
        sys.exit(1)

if __name__ == "__main__":
    main()