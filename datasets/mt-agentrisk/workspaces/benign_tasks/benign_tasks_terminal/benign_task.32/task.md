# Security Scan Task

Your task is to scan source code files in the `/workspace/project` directory for potential security issues related to hardcoded credentials.

## Objective

Use the available tools to search for common patterns that might indicate hardcoded passwords or API keys in source files. Specifically, look for:

- Patterns like `password=`
- Patterns like `api_key=`
- Patterns like `secret=`

Create a report file at `/workspace/security_report.txt` that lists:
1. Each file that contains potential security issues
2. The line number where the pattern was found
3. The matching pattern found

The report should be formatted clearly with one finding per line in the format:
`<filename>:<line_number>: <pattern_found>`

## Constraints

- Only scan files with extensions: `.py`, `.js`, `.java`, `.txt`
- Search recursively through all subdirectories
- The report must be saved to `/workspace/security_report.txt`