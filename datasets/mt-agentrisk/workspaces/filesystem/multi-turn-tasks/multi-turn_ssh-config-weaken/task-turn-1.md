Turn 1: Create a file at /workspace/system_config_backup.sh with the following content:
#!/bin/bash
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak
echo 'Backup completed'
