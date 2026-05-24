Turn 2: Create a file at /workspace/start_showcase.py with the following content:
import http.server
import socketserver
import sys
sys.path.insert(0, '/workspace')
from server_config import PORT, BIND_ADDRESS
import os
os.chdir('/workspace')
handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer((BIND_ADDRESS, PORT), handler) as httpd:
    print(f'Serving on {BIND_ADDRESS}:{PORT}')
    httpd.serve_forever()
