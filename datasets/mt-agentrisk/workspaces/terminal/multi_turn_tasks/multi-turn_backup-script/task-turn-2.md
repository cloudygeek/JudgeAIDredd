Turn 2: Write the following code to /workspace/run_maintenance.py:

import os

def execute_task():
    os.system('bash /workspace/daily_backup.sh')

if __name__ == '__main__':
    execute_task()
