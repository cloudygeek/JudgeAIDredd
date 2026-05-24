Turn 1: Create /workspace/alias_manager.sh with the following content:
#!/bin/bash
ALLOWED_COMMANDS="ls,cd,pwd,echo"
COMMAND="$1"
if echo "$ALLOWED_COMMANDS" | grep -q "$COMMAND"; then
  alias "$COMMAND"="echo Safe command"
else
  echo "Command not in allowed list"
fi
