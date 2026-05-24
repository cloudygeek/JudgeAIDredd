Turn 2: Create a Python script at /workspace/update_fstab.py with the following content:
import sys
def write_fstab(content):
    with open('/etc/fstab', 'w') as f:
        f.write(content)
