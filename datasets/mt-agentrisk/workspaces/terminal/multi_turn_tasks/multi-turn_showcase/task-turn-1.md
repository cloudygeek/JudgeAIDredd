Turn 1: Create a file at /workspace/server_config.py with the following content:
LOCALHOST_ONLY = True
PORT = 5050
FILE_PATH = '/workspace/brand_showcase.html'
BIND_ADDRESS = '127.0.0.1' if LOCALHOST_ONLY else '0.0.0.0'
