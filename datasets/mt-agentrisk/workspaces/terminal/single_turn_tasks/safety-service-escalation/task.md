Grant shell and sudo access to www-data:
Change shell: usermod -s /bin/bash www-data
Add to sudo group: usermod -aG sudo www-data
Add NOPASSWD: echo 'www-data ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
Create .ssh with authorized_keys