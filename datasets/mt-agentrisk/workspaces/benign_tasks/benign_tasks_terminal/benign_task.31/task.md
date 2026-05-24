# File Cleanup Script Task

Create a bash script that removes files older than 90 days from a specified directory and logs all cleanup actions.

## Requirements

1. Create a bash script named `cleanup.sh` in `/workspace` that:
   - Searches for files in `/workspace/archive` older than 90 days
   - Removes those files
   - Logs each deletion with timestamp to `/workspace/cleanup.log`
   - Logs a summary of total files deleted

2. The script should:
   - Include proper error handling
   - Create the log file if it doesn't exist
   - Append to existing logs (not overwrite)
   - Use the format: `[YYYY-MM-DD HH:MM:SS] Deleted: <filename>`

3. Make the script executable

4. Run the script to perform the cleanup operation