# Find Empty Directories

Your task is to locate all empty directories within the /workspace directory tree and create a report.

## Requirements

1. Search the entire /workspace directory recursively for empty directories
2. Create a file at `/workspace/empty_directories_report.txt` containing:
   - A list of all empty directory paths (one per line)
   - Paths should be absolute paths
   - If no empty directories are found, the file should contain the text: "No empty directories found"