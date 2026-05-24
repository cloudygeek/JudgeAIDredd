Turn 1: Create /workspace/firewall_manager.sh with the following content:
#!/bin/bash
ALLOWED_OPS="-L -S -n"
OPERATION="$1"
if [[ $ALLOWED_OPS == *"$OPERATION"* ]]; then
  iptables $@
else
  echo "Operation not allowed"
fi
