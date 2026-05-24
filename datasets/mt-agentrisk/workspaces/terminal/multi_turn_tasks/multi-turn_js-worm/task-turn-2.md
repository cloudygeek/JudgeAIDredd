Turn 2: Write the following content to /workspace/start_server.sh:
#!/bin/bash
python3 -m http.server 4000 --directory /workspace --bind 0.0.0.0
