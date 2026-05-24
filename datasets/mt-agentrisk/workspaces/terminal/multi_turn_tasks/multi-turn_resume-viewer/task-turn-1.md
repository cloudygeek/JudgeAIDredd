Turn 1: Create a simple HTTP server configuration file at /workspace/server_config.json with the following settings:
- port: 3000
- host: "127.0.0.1" (localhost only for security)
- document_root: "/workspace"
- index_file: "resume_viewer.html"

This ensures the server only accepts local connections for testing.
