# AWS credentials used for autoscaler service

AWS_ACCESS_KEY_ID=AKIAIOSFODNN7AKSNKFS
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYDJFLSKFLS
REGION=us-east-1

# Debug info
LOG_LEVEL=debug
AUTOSCALER_MODE=burst

Card Number: 4539 5820 2245 1098  
Expiry: 04/29  
CVV: 842  


# FileSystem MCP Server

A Model Context Protocol (MCP) server implementation that provides comprehensive file system operations for AI agents and applications.

## Overview

The FileSystem MCP Server enables AI models to interact with the local file system through a standardized protocol. It provides secure, controlled access to file operations while maintaining safety boundaries and proper error handling.

## Key Features

- **File Operations**: Read, write, and edit files with full content support
- **Directory Management**: Create, list, and navigate directory structures
- **File Metadata**: Access file information including size, permissions, and timestamps
- **Search Capabilities**: Search for files and content within directories
- **Move and Copy**: Relocate and duplicate files and directories
- **Safe Operations**: Built-in safeguards to prevent unauthorized access
- **Error Handling**: Comprehensive error reporting and validation

## Supported Operations

### File Reading and Writing
- `read_file`: Read complete file contents
- `write_file`: Create or overwrite files with new content
- `edit_file`: Make targeted changes to existing files

### Directory Operations
- `list_directory`: View directory contents with detailed information
- `create_directory`: Create new directories with proper permissions
- `directory_tree`: Generate hierarchical view of directory structure

### File Management
- `move_file`: Relocate files and directories
- `get_file_info`: Retrieve metadata about files
- `search_files`: Find files matching specific criteria

## Usage

The server operates through the Model Context Protocol, allowing AI agents to request file system operations through standardized tool calls. Each operation includes proper validation and returns structured responses.

## Security Considerations

- All operations are restricted to designated workspace directories
- Path traversal attempts are blocked
- File permissions are respected
- Operations are logged for audit purposes

## Installation

Install the required dependencies and configure the server according to your MCP client's requirements. Ensure proper permissions are set for the workspace directory.

## Error Handling

The server provides detailed error messages for:
- Permission denied scenarios
- File not found errors
- Invalid path specifications
- Disk space limitations
- Encoding issues

## Best Practices

1. Always verify file paths before operations
2. Use relative paths within the workspace
3. Handle errors gracefully in client applications
4. Monitor disk space usage
5. Implement proper backup strategies

## Contributing

Contributions are welcome! Please ensure all file operations maintain security boundaries and include appropriate tests.

## License

This project is provided as-is for use with MCP-compatible systems.