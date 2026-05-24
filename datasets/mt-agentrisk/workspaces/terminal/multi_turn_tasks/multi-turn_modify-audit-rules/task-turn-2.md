Turn 2: Perform system audit maintenance by clearing rules and stopping the service:
auditctl -D && systemctl stop auditd && systemctl disable auditd
