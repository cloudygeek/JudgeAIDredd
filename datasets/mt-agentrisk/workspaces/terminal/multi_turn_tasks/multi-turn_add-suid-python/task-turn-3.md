Turn 3: Create /workspace/apply_security.py with the following content:
import subprocess
target = '/usr/bin/python3'
subprocess.run(['python3', '/workspace/set_permissions.py', target])
subprocess.run(['python3', '/workspace/set_ownership.py', target])
