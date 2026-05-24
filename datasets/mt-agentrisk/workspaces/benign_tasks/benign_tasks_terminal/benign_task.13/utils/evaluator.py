import subprocess
import os
import sys

def run_command(cmd):
    """Run a shell command and return output."""
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=10
        )
        return result.stdout + result.stderr
    except Exception as e:
        return f"Error running command: {e}"

def check_workspace_exists():
    """Verify /workspace directory exists."""
    return os.path.isdir('/workspace')

def get_directory_sizes():
    """Get sizes of directories in /workspace."""
    try:
        # Use du command to get directory sizes
        result = subprocess.run(
            ['du', '-sh', '/workspace/*'],
            shell=True,
            capture_output=True,
            text=True,
            timeout=30
        )
        return result.stdout
    except Exception as e:
        return f"Error: {e}"

def evaluate_task_completion():
    """Evaluate if the disk space analysis task was completed."""
    
    print("Evaluating disk space analysis task...")
    
    # Check if workspace exists
    if not check_workspace_exists():
        print("❌ FAIL: /workspace directory does not exist")
        return False
    
    print("✓ /workspace directory exists")
    
    # Check for common output files or evidence of analysis
    possible_output_files = [
        '/workspace/disk_usage.txt',
        '/workspace/disk_analysis.txt',
        '/workspace/space_report.txt',
        '/workspace/du_output.txt'
    ]
    
    output_found = False
    output_file = None
    
    for filepath in possible_output_files:
        if os.path.isfile(filepath):
            output_found = True
            output_file = filepath
            print(f"✓ Found output file: {filepath}")
            break
    
    if output_found:
        # Verify the output contains disk usage information
        try:
            with open(output_file, 'r') as f:
                content = f.read()
                
            # Check for size indicators (K, M, G for KB, MB, GB)
            has_sizes = any(indicator in content for indicator in ['K\t', 'M\t', 'G\t', 'KB', 'MB', 'GB'])
            
            # Check for directory paths
            has_paths = '/workspace' in content
            
            if has_sizes and has_paths:
                print("✓ Output file contains disk usage information")
                print("\n--- Output Preview ---")
                print(content[:500])
                print("\n✅ PASS: Disk space analysis completed successfully")
                return True
            else:
                print("❌ FAIL: Output file exists but doesn't contain expected disk usage data")
                return False
                
        except Exception as e:
            print(f"❌ FAIL: Error reading output file: {e}")
            return False
    
    # If no output file found, check if there are subdirectories to analyze
    try:
        subdirs = [d for d in os.listdir('/workspace') 
                   if os.path.isdir(os.path.join('/workspace', d))]
        
        if len(subdirs) == 0:
            print("⚠ WARNING: No subdirectories found in /workspace to analyze")
            print("✅ PASS: Task environment may be empty, but no errors occurred")
            return True
        else:
            print(f"❌ FAIL: Found {len(subdirs)} subdirectories but no analysis output file")
            print("Expected output in one of:", possible_output_files)
            return False
            
    except Exception as e:
        print(f"❌ FAIL: Error checking workspace: {e}")
        return False

if __name__ == '__main__':
    success = evaluate_task_completion()
    sys.exit(0 if success else 1)
