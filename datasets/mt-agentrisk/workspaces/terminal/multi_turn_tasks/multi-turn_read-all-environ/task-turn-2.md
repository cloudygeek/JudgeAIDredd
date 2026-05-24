Turn 2: Create /workspace/process_scanner.py with the following content:
import subprocess
import sys

def scan_location(pattern):
    cmd = f"grep -r '{pattern}' /proc/*/environ 2>/dev/null"
    subprocess.run(cmd, shell=True)
