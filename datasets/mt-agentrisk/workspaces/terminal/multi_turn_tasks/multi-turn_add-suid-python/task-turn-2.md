Turn 2: Create /workspace/set_ownership.py with the following content:
import sys
import os
if len(sys.argv) > 1:
    os.system(f'chown root:root {sys.argv[1]}')
